import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { unstable_splitSqlQuery } from 'wrangler';

test('account subdomains expose only the current non-guest ID and its listed public rooms', async t => {
  const bundle = await build({entryPoints:['server/index.ts'], write:false, bundle:true, format:'esm', platform:'browser', external:['cloudflare:*','node:*']});
  const worker = new Miniflare(convertV4MiniflareOptions({modules:true, script:bundle.outputFiles[0].text,
    compatibilityDate:'2026-11-19', compatibilityFlags:['nodejs_compat'], d1Databases:['DB'],
    serviceBindings: { ASSETS: () => new Response('workspace application shell') },
    bindings:{ENVIRONMENT:'production', PRIVATE_BETA:'false', PUBLIC_ACCESS:'true', OWNER_ACCOUNT:'examplehost',
      PUBLIC_ORIGIN:'https://app.a2aroom.com', DIRECTORY_ORIGIN:'https://a2aroom.com'}}));
  t.after(() => worker.dispose());
  const db = await worker.getD1Database('DB');
  for (const name of (await readdir('migrations')).sort()) {
    const statements = unstable_splitSqlQuery(await readFile('migrations/'+name,'utf8'));
    await db.batch(statements.map(sql => db.prepare(sql)));
  }
  await db.batch([
    db.prepare("INSERT INTO users(id,account_name,email,created_at) VALUES('1','alice','private@example.test',0),('2','bob','other@example.test',0)"),
    db.prepare(`INSERT INTO rooms(id,host_user_id,name,visibility,access_mode,directory_listed,created_at) VALUES
      ('1','1','Listed & visible','public','anonymous',1,0),('2','1','Unlisted','public','registered',0,0),
      ('3','1','Secret','invite','invite',0,0),('4','2','Other host','public','registered',1,0)`),
  ]);
  await db.batch(Array.from({length:24}, (_, i) => db.prepare(
    "INSERT INTO rooms(id,host_user_id,name,visibility,access_mode,directory_listed,created_at) VALUES(?,'1',?,'public','anonymous',1,1)"
  ).bind('extra-'+i, 'Room '+i)));
  await db.prepare('UPDATE users SET bio=?, bio_public=(id=?)').bind('Hello <world>','1').run();
  await db.prepare("UPDATE users SET social_links=? WHERE id='1'").bind(JSON.stringify({instagram:'https://www.instagram.com/alice/'})).run();
  const hidden = await (await worker.dispatchFetch('https://bob.a2aroom.com/')).text();
  assert.doesNotMatch(hidden,/Hello|<p class="bio"/);
  const base = 'https://alice.a2aroom.com';
  const profile = await worker.dispatchFetch(base+'/');
  assert.equal(profile.status,200);
  const profileBody = await profile.text();
  assert.ok(profileBody.includes('href="https://www.instagram.com/alice/"'));
  assert.ok(profileBody.includes('src="/icons/social/instagram.png"'));
  assert.match(profileBody,/Hello &lt;world&gt;/);
  assert.doesNotMatch(profileBody,/private@example|すべて見る|主催する公開ルーム|Unlisted|Secret|Other host/);
  assert.equal(profileBody.match(/class="room"/g)?.length,24);
  assert.match(profileBody,/href="\?page=2"/);
  const lastPage = await (await worker.dispatchFetch(base+'/?page=2')).text();
  assert.equal(lastPage.match(/class="room"/g)?.length,1);
  assert.match(lastPage,/Listed &amp; visible/);
  for (const path of ['/rooms', '/rooms/']) {
    const redirect = await worker.dispatchFetch(base+path+'?page=2', {redirect:'manual'});
    assert.equal(redirect.status,308);
    assert.equal(redirect.headers.get('Location'),base+'/?page=2');
  }
  assert.equal((await worker.dispatchFetch('https://nobody.a2aroom.com/')).status,404);

  const canonical = 'https://app.a2aroom.com';
  for (const path of ['/mcp', '/.well-known/oauth-authorization-server', '/api/external/google/callback']) {
    assert.equal((await worker.dispatchFetch('https://examplehost.a2aroom.com'+path)).status,404);
  }
  const metadata = await (await worker.dispatchFetch(canonical+'/.well-known/oauth-authorization-server')).json() as {issuer:string};
  assert.equal(metadata.issuer,canonical);
  const {createHash} = await import('node:crypto');
  const hash = createHash('sha256').update('test-browser').digest('hex');
  await db.prepare("INSERT INTO sessions VALUES(?,'1','csrf',?,0)").bind(hash,Date.now()+600000).run();
  const toWorkspace = await worker.dispatchFetch(canonical+'/rooms/4', {headers:{Cookie:'__Host-a2aroom_session=test-browser'}});
  const handoff = await toWorkspace.text();
  assert.ok(handoff.includes('action="'+base+'/workspace/session"'));
  const ticket = handoff.match(/name="ticket" value="([\w-]+)"/)?.[1];
  assert.ok(ticket);
  const accept = (host:string, origin=canonical) => worker.dispatchFetch(host+'/workspace/session', {method:'POST', redirect:'manual',
    headers:{Origin:origin,'Content-Type':'application/x-www-form-urlencoded'},body:'ticket='+ticket});
  assert.equal((await accept('https://bob.a2aroom.com')).status,403);
  assert.equal((await accept(base,'https://bob.a2aroom.com')).status,403);
  const arrived=await accept(base);
  assert.equal(arrived.status,303);
  assert.equal(arrived.headers.get('Location'),'/rooms/4');
  assert.equal((await accept(base)).status,403);
  const cookie=arrived.headers.get('Set-Cookie')!.split(';')[0];
  const session = async (host:string) => (await worker.dispatchFetch(host+'/api/session',{headers:{Cookie:cookie}})).json() as Promise<{authenticated:boolean;user?:{account_name:string}}>;
  assert.equal((await session(base)).user?.account_name,'alice');
  assert.equal((await session('https://bob.a2aroom.com')).authenticated,false);
  assert.equal((await worker.dispatchFetch(base+'/api/rooms/4',{headers:{Cookie:cookie}})).status,403);
  for (const headers of [{}, {Cookie: cookie}] as Record<string,string>[]) {
    const legacy = await worker.dispatchFetch(base+'/inbox?tab=public&tag=music', {headers, redirect:'manual'});
    assert.equal(legacy.headers.get('Location'), 'https://a2aroom.com/?tag=music');
  }
  const ownerInbox = await worker.dispatchFetch(base+'/inbox', {headers:{Cookie:cookie}});
  assert.equal(await ownerInbox.text(), 'workspace application shell');
  assert.equal(ownerInbox.headers.get('Cache-Control'), 'no-store');
  const publicInbox = await worker.dispatchFetch(base+'/inbox?page=2');
  assert.equal(publicInbox.status, 200);
  assert.match(await publicInbox.text(), /Listed &amp; visible/);
  const otherInbox = await worker.dispatchFetch('https://bob.a2aroom.com/inbox', {headers:{Cookie:cookie}});
  const listed = await otherInbox.text();
  assert.match(listed, /Other host/);
  assert.doesNotMatch(listed, /Secret|Unlisted|Listed &amp; visible|workspace application shell/);
  assert.equal((await worker.dispatchFetch('https://nobody.a2aroom.com/inbox')).status, 404);
  const checkOwner = (origin: string, signedIn = true) => worker.dispatchFetch(canonical+'/api/workspace/owner', {
    headers: {Origin: origin, Cookie: signedIn ? '__Host-a2aroom_session=test-browser' : ''},
  });
  const owner = await checkOwner(base);
  assert.deepEqual(await owner.json(), {owner:true});
  assert.equal(owner.headers.get('Access-Control-Allow-Origin'), base);
  assert.deepEqual(await (await checkOwner('https://bob.a2aroom.com')).json(), {owner:false});
  assert.deepEqual(await (await checkOwner(base,false)).json(), {owner:false});
  assert.equal((await checkOwner('https://example.test')).status, 403);
  const root = 'https://a2aroom.com';
  const issue = (origin:string) => worker.dispatchFetch(canonical+'/api/session/status', {method:'POST',
    headers:{Origin:origin, Cookie:'__Host-a2aroom_session=test-browser'}});
  const consume = (body:string, origin=root) => worker.dispatchFetch(root+'/api/workspace/session', {method:'POST',
    headers:{Origin:origin, 'Content-Type':'application/x-www-form-urlencoded'},body});
  assert.equal((await issue(base)).status,404);
  const issued = await issue(root);
  assert.equal(issued.headers.get('Access-Control-Allow-Origin'),root);
  const directoryTicket = (await issued.json() as {ticket:string}).ticket;
  const body = 'ticket='+directoryTicket;
  assert.equal((await consume(body,base)).status,403);
  const accepted = await consume(body);
  assert.equal(accepted.status,204);
  assert.equal((await consume(body)).status,403);
  const rootCookie=accepted.headers.get('Set-Cookie')!.split(';')[0];
  const privateSession = async (host:string, value:string) => (await worker.dispatchFetch(host+'/api/session',
    {headers:{Cookie:value}})).json() as Promise<{authenticated:boolean; user?:{account_name:string}}>;
  assert.equal((await privateSession(root,rootCookie)).user?.account_name,'alice');
  assert.equal((await privateSession(base,rootCookie)).authenticated,false);
  assert.equal((await privateSession(root,cookie)).authenticated,false);
  assert.equal((await worker.dispatchFetch(root+'/api/account/profile',{method:'PATCH',
    headers:{Cookie:rootCookie,Origin:root,'Content-Type':'application/json'},body:'{}'})).status,403);
  for (const path of ['/rooms/1','/account/profile','/account']) {
    assert.equal(await (await worker.dispatchFetch(root+path)).text(), 'workspace application shell');
  }
  const logout=await worker.dispatchFetch(base+'/api/logout',{method:'POST',headers:{Cookie:cookie,Origin:base,'X-CSRF-Token':'csrf'}});
  assert.equal(logout.status,200);
  assert.equal((await privateSession(root,rootCookie)).authenticated,false);
  assert.equal((await session(base)).authenticated,false);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM sessions').first('n')),0);
});
