import assert from 'node:assert/strict';
import { createHmac, createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { unstable_splitSqlQuery } from 'wrangler';
import { webhookTarget } from '../server/webhook';

test('webhook admission rejects nonpublic destinations and mixed DNS answers', async () => {
  for (const url of ['http://example.com', 'https://localhost', 'https://127.1', 'https://10.1.2.3',
    'https://[::1]', 'https://[fd00::1]', 'https://[::ffff:127.0.0.1]', 'https://169.254.169.254']) {
    await assert.rejects(webhookTarget(url));
  }
  await assert.rejects(webhookTarget('https://receiver.example', async (_, type) => type === 'A' ? ['8.8.8.8'] : ['fc00::1']));
});

test('worker delivers a signed wake immediately, retries, disables and notifies the owner', { timeout: 45_000 }, async t => {
  const bundle = await build({ entryPoints: ['server/index.ts'], write: false, bundle: true, format: 'esm',
    platform: 'browser', external: ['cloudflare:*', 'node:*'], target: 'es2022' });
  const deliveries: { timestamp: string; signature: string; body: string }[] = [];
  let status = 204;
  let address = '8.8.8.8';
  const origin = 'https://app.a2aroom.com';
  const options = (publicAccess:boolean) => convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-11-19', compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'],
    d1Databases: ['DB'], kvNamespaces: ['OAUTH_KV'], durableObjects: { PUSH: { className: 'PushHub', useSQLite: true }, DIRECTORY: { className:'DirectoryHub', useSQLite:true } },
    bindings: { ENVIRONMENT: 'production', PUBLIC_ORIGIN: origin, DIRECTORY_ORIGIN: 'https://a2aroom.com', PRIVATE_BETA: String(!publicAccess), PUBLIC_ACCESS: String(publicAccess), OWNER_ACCOUNT: 'examplehost' },
    outboundService: async req => {
      const url = new URL(req.url);
      if (url.hostname === 'cloudflare-dns.com') {
        return Response.json({ Status: 0, Answer: url.searchParams.get('type') === 'A' ? [{ type: 1, data: address }] : [] });
      }
      assert.equal(req.url, 'https://receiver.example/hook');
      assert.equal(req.method, 'POST');
      deliveries.push({ body: await req.text(), signature: req.headers.get('X-A2ARoom-Signature')!,
        timestamp: req.headers.get('X-A2ARoom-Timestamp')! });
      return new Response(null, { status });
    },
  });
  const mf = new Miniflare(options(false));
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  for (const name of (await readdir('migrations')).sort()) {
    const sql = unstable_splitSqlQuery(await readFile('migrations/' + name, 'utf8'));
    await db.batch(sql.map(statement => db.prepare(statement)));
  }
  const directoryOrigin='https://a2aroom.com';
  for (const path of ['/api/session','/api/session/status','/mcp','/authorize','/.well-known/oauth-authorization-server','/api/public/rooms/test/messages']) {
    assert.equal((await mf.dispatchFetch(directoryOrigin+path)).status,404);
  }
  for (const host of [directoryOrigin, origin]) {
    for (const path of ['/directory', '/explore', '/directory/', '/explore/']) {
      const redirect = await mf.dispatchFetch(host + path + '?tag=music&sort=recent&mode=registered&next=private', { redirect: 'manual' });
      assert.equal(redirect.status, 302);
      assert.equal(redirect.headers.get('Location'), directoryOrigin + '/?tag=music&sort=recent&mode=registered');
    }
  }
  const skill=await mf.dispatchFetch(directoryOrigin+'/agent-skill/SKILL.md',{redirect:'manual'});
  assert.equal(skill.status,308);
  assert.equal(skill.headers.get('Location'),origin+'/agent-skill/SKILL.md');
  assert.equal((await mf.dispatchFetch(directoryOrigin+'/privacy')).status,200);
  const publicList=await (await mf.dispatchFetch(directoryOrigin+'/api/explore/rooms')).json() as {rooms:unknown[];participation_open:boolean};
  assert.deepEqual(publicList.rooms,[]);
  assert.equal(publicList.participation_open,false);
  const session = 'synthetic-session';
  const hash = createHash('sha256').update(session).digest('hex');
  await db.batch([
    db.prepare("INSERT INTO users(id,account_name,email,created_at) VALUES('u','examplehost','test@example.test',1)"),
    db.prepare("INSERT INTO sessions VALUES(?,'u','csrf',?,0)").bind(hash, Date.now() + 60_000),
    db.prepare("INSERT INTO agents(id,owner_id,name,handle,platform,created_at) VALUES('a','u','Muse','muse','test',0)"),
    db.prepare("INSERT INTO rooms(id,host_user_id,name,visibility,created_at) VALUES('r','u','private','invite',1)"),
    db.prepare("INSERT INTO room_members (id,room_id,user_id,agent_id,kind,joined_at) VALUES('member','r','u','a','agent',1),('human','r','u',NULL,'human',1)"),
  ]);
  await t.test('the public directory can read login status and the signed-in user’s rooms from the account host', async () => {
    const statusUrl = origin + '/api/session/status';
    const cookie = '__Host-a2aroom_session=' + session;
    for (const [value, signedIn] of [[cookie, true], ['', false], ['__Host-a2aroom_session=expired', false]] as const) {
      const r = await mf.dispatchFetch(statusUrl, { headers: { Origin: directoryOrigin, Cookie: value } });
      assert.equal(r.status, 200);
      assert.deepEqual(await r.json(), { authenticated: signedIn });
      assert.equal(r.headers.get('Access-Control-Allow-Origin'), directoryOrigin);
      assert.equal(r.headers.get('Access-Control-Allow-Credentials'), 'true');
      assert.equal(r.headers.get('Vary'), 'Origin');
      assert.equal(r.headers.get('Cache-Control'), 'no-store');
    }
    for (const other of ['https://staging.a2aroom.com', 'https://example.test', 'null']) {
      const r = await mf.dispatchFetch(statusUrl, { headers: { Origin: other, Cookie: cookie } });
      assert.equal(r.status, 403);
      assert.equal(r.headers.get('Access-Control-Allow-Origin'), null);
    }
    const sameOrigin = await mf.dispatchFetch(statusUrl, { headers: { Cookie: cookie } });
    assert.deepEqual(await sameOrigin.json(), { authenticated: true });
    const inbox = await mf.dispatchFetch(origin + '/api/rooms', {headers:{Origin:directoryOrigin,Cookie:cookie}});
    assert.equal(inbox.headers.get('Access-Control-Allow-Origin'), directoryOrigin);
    assert.deepEqual((await inbox.json() as {rooms:{id:string}[]}).rooms.map(room => room.id), ['r']);
    const guestInbox = await mf.dispatchFetch(origin + '/api/rooms', {headers:{Origin:directoryOrigin}});
    assert.equal(guestInbox.status,401);
    const avatarUrl = origin + '/api/account/avatar';
    const headers = { Origin: directoryOrigin, Cookie: cookie };
    assert.equal((await mf.dispatchFetch(avatarUrl, { headers })).status, 204);
    assert.equal((await mf.dispatchFetch(avatarUrl, { headers: { Origin: directoryOrigin } })).status, 401);
    const bytes = await readFile('public/icons/favicon-32.png');
    await db.prepare("INSERT INTO profile_images VALUES('user','u','u','image/png',?,1)").bind([...bytes]).run();
    const photo = await mf.dispatchFetch(avatarUrl, { headers });
    assert.equal(photo.status, 200);
    assert.equal(photo.headers.get('Access-Control-Allow-Origin'), directoryOrigin);
    assert.equal(photo.headers.get('Access-Control-Allow-Credentials'), 'true');
    assert.equal(photo.headers.get('Cache-Control'), 'no-store');
    assert.equal(photo.headers.get('Content-Type'), 'image/png');
    assert.deepEqual(Buffer.from(await photo.arrayBuffer()), bytes);
    const portraitUrl = origin + '/api/images/user/u?v=1';
    const portrait = await mf.dispatchFetch(portraitUrl, { headers });
    assert.equal(portrait.headers.get('Access-Control-Allow-Origin'), directoryOrigin);
    assert.deepEqual(Buffer.from(await portrait.arrayBuffer()), bytes);
    assert.equal((await mf.dispatchFetch(portraitUrl, { headers: { Origin: directoryOrigin } })).status, 401);
    const blocked = await mf.dispatchFetch(avatarUrl, { headers: { ...headers, Origin: 'https://example.test' } });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.headers.get('Access-Control-Allow-Origin'), null);
    const fullSession = await mf.dispatchFetch(origin + '/api/session', { headers: { Origin: directoryOrigin, Cookie: cookie } });
    assert.equal(fullSession.headers.get('Access-Control-Allow-Origin'), null);
  });
  async function api(path: string, method = 'GET', data?: unknown) {
    const r = await mf.dispatchFetch(origin + '/api' + path, { method, headers: { Origin: origin, Cookie: '__Host-a2aroom_session=' + session,
      'Content-Type': 'application/json', 'X-CSRF-Token': 'csrf' }, body: JSON.stringify(data) });
    assert.ok(r.ok, await r.clone().text());
    return r.json() as Promise<Record<string, any>>;
  }
  await t.test('a past ID does not resolve to a room', async () => {
    await db.prepare("INSERT INTO account_names(name,user_id) VALUES('past-name','u')").run();
    assert.equal((await mf.dispatchFetch('https://past-name.a2aroom.com/rooms/room-123',{redirect:'manual'})).status,404);
  });
  const path = '/agents/a/webhook';
  const { secret } = await api(path, 'PUT', { url: 'https://receiver.example/hook' });
  const deadline = async (condition: () => Promise<boolean>, limit = 4000) => {
    const end = Date.now() + limit;
    while (!(await condition())) {
      assert.ok(Date.now() < end, 'delivery deadline exceeded');
      await new Promise(resolve => setTimeout(resolve, 30));
    }
  };
  const first = await api('/rooms/r/messages', 'POST', { body: '@examplehost/muse confidential' });
  await deadline(async () => (await api(path)).logs.length === 1);
  const received = deliveries[0];
  assert.deepEqual(JSON.parse(received.body), { event: 'new_message', room_id: 'r', seq: 1, mentioned: true, message_id: first.id });
  assert.equal(received.signature, 'v1=' + createHmac('sha256', secret).update(received.timestamp + '.' + received.body).digest('hex'));
  assert.equal((await api(path)).logs[0].success, 1);
  status = 503;
  await api('/rooms/r/messages', 'POST', { body: 'again' });
  const ns = await mf.getDurableObjectNamespace('PUSH');
  for (let attempt = 1; attempt <= 3; attempt++) {
    await deadline(async () => (await api(path)).logs.length === attempt + 1, attempt === 2 ? 15_000 : 4000);
    const row = await db.prepare('SELECT due_at FROM agent_wakes WHERE seq=2').first<{ due_at: number }>();
    assert.ok(row && row.due_at > Date.now());
    if (attempt === 1) continue; // Exercise the real ten-second alarm once.
    // Advance the retry deadline without making the test sleep for six minutes.
    await db.prepare('UPDATE agent_wakes SET due_at=1 WHERE seq=2').run();
    if (attempt === 3) address = '10.0.0.2';
    await ns.get(ns.idFromName('a')).fetch('https://push/wake', { method: 'POST', body: 'a' });
  }
  await deadline(async () => (await api(path)).hook.enabled === 0);
  const detail = await api(path);
  assert.deepEqual(detail.logs.map((l: { status: number | null }) => l.status), [null, 503, 503, 503, 204]);
  const initialRetryInterval = detail.logs[2].created_at - detail.logs[3].created_at;
  assert.ok(initialRetryInterval >= 9800 && initialRetryInterval <= 15_000);
  assert.equal(deliveries.length, 4);
  assert.equal((await api('/notifications')).notifications[0].kind, 'webhook_disabled');
  assert.equal(detail.hook.secret, undefined);
  await api(path, 'DELETE');
  assert.equal((await api(path)).hook, null);
  // Removing membership also cancels pending retries.
  address = '8.8.8.8';
  const rotated = await api(path, 'PUT', { url: 'https://receiver.example/hook' });
  assert.notEqual(rotated.secret, secret);
  await api('/rooms/r/messages', 'POST', { body: 'pending at removal' });
  await deadline(async () => (await api(path)).logs.length === 6);
  await db.prepare("DELETE FROM room_members WHERE id='member'").run();
  assert.equal(await db.prepare('SELECT COUNT(*) AS count FROM agent_wakes').first('count'), 0);
  await api('/rooms/r/messages', 'POST', { body: 'after removal' });
  assert.equal(await db.prepare('SELECT COUNT(*) AS count FROM agent_wakes').first('count'), 0);
  await t.test('browser inbox wakes only an authenticated session and fetches the preview separately', async () => {
    const listen = (cookie: string, source = origin) => mf.dispatchFetch(origin + '/api/inbox/live',
      { headers: { Origin: source, Cookie: cookie, Upgrade: 'websocket' } });
    const cookie = '__Host-a2aroom_session=' + session;
    assert.equal((await listen('')).status, 401);
    assert.equal((await listen(cookie, directoryOrigin)).status, 403);
    const socket = (await listen(cookie)).webSocket;
    assert.ok(socket);
    socket.accept();
    try {
      const signals: unknown[] = [];
      socket.addEventListener('message', event => signals.push(event.data));
      await api('/rooms/r/agents', 'POST', { agent_id: 'a' });
      await api('/rooms/r/messages', 'POST', { body: 'outgoing message' });
      assert.equal((await api('/inbox/latest')).message, null);
      const connection = await api('/agents/a/connections', 'POST', { label: 'inbox test' });
      const response = await mf.dispatchFetch(origin + '/mcp', {
        method: 'POST', headers: { Authorization: 'Bearer ' + connection.token, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'post_message', arguments: { room_id: 'r', body: 'incoming reply' } } }),
      });
      const rpc = await response.json() as { result: { isError?: boolean } };
      assert.equal(Boolean(rpc.result.isError), false);
      await deadline(async () => signals.length > 0);
      assert.deepEqual(signals, ['changed']);
      const { message } = await api('/inbox/latest');
      assert.equal(message.preview, 'incoming reply');
      assert.equal((await api('/inbox/latest?after=' + message.seq)).message, null);
    } finally { socket.close(); }
  });

  await t.test('guest MCP delivers signed wakes only during its live room session', async () => {
    await mf.setOptions(options(true));
    const db = await mf.getD1Database('DB');
    status = 204; address = '8.8.8.8';
    const {id:room} = await api('/rooms','POST',{name:'Guest webhook fixture',access_mode:'anonymous',directory_listed:true});
    const headers:Record<string,string> = {'Content-Type':'application/json',Accept:'application/json, text/event-stream'};
    const rpc = (method:string, params:Record<string,unknown>) => mf.dispatchFetch(origin+'/api/public/mcp',{
      method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),
    });
    const init = await rpc('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'fixture',version:'1'}});
    assert.equal(init.status,200); headers['Mcp-Session-Id']=init.headers.get('Mcp-Session-Id')!;
    const call = async (name:string,args:Record<string,unknown>={}) => {
      const response = await rpc('tools/call',{name,arguments:args});
      assert.equal(response.status,200);
      return ((await response.json()) as {result:{content:{text:string}[];isError?:boolean}}).result;
    };
    const target = {url:'https://receiver.example/hook'};
    assert.ok((await call('set_my_webhook',target)).isError);
    const joined=await call('join_room',{room_id:room,name:'Listener'});
    const {agent_id} = JSON.parse(joined.content[0].text);
    const hook = await call('set_my_webhook',target);
    const {secret} = JSON.parse(hook.content[0].text);
    assert.ok(secret);
    const other = await api('/rooms/r/messages','POST',{body:'Outside the guest room'});
    assert.equal(await db.prepare('SELECT COUNT(*) FROM agent_wakes e JOIN messages m ON m.seq=e.seq WHERE m.id=? AND e.agent_id=?')
      .bind(other.id,agent_id).first('COUNT(*)'),0);
    const sent = await api('/rooms/'+room+'/messages','POST',{body:'Local webhook fixture'});
    const wake = () => deliveries.find(d=>JSON.parse(d.body).message_id===sent.id);
    await deadline(async()=>Boolean(wake()));
    const delivery = wake()!;
    assert.equal(JSON.parse(delivery.body).room_id,room);
    assert.equal(delivery.signature,'v1='+createHmac('sha256',secret).update(delivery.timestamp+'.'+delivery.body).digest('hex'));
    assert.deepEqual(JSON.parse((await call('get_my_webhook')).content[0].text),{configured:true,enabled:true,origin:'https://receiver.example'});
    assert.ok(!(await call('remove_my_webhook')).isError);
    assert.equal(JSON.parse((await call('get_my_webhook')).content[0].text).configured,false);
    assert.ok(!(await call('set_my_webhook',target)).isError);
    // The delivery worker must stop at expiry, even before the scheduled membership cleanup.
    await db.prepare('UPDATE guest_sessions SET expires_at=0 WHERE user_id=?').bind(agent_id).run();
    const late = await api('/rooms/'+room+'/messages','POST',{body:'After expiry'});
    await deadline(async()=>Boolean(await db.prepare('SELECT 1 FROM agent_wakes e JOIN messages m ON m.seq=e.seq WHERE m.id=? AND e.agent_id=? AND e.due_at IS NULL')
      .bind(late.id,agent_id).first()));
    assert.equal(deliveries.some(d=>JSON.parse(d.body).message_id===late.id),false);
    assert.equal((await rpc('tools/call',{name:'set_my_webhook',arguments:target})).status,404);
  });

});
