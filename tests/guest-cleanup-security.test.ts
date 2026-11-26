import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { unstable_splitSqlQuery } from 'wrangler';

test('guest cleanup retains history and active sessions, while expelled authors cannot edit', async t => {
  const bundle = await build({stdin:{resolveDir:process.cwd(),loader:'ts',contents:`
    import app, {PushHub,DirectoryHub} from './server/index'; export {PushHub,DirectoryHub};
    export default {async fetch(req,env,ctx) {
      if (new URL(req.url).pathname==='/__test_scheduled') {
        const tasks=[]; await app.scheduled({scheduledTime:Date.now()},env,{waitUntil:p=>tasks.push(p)});
        await Promise.all(tasks); return new Response('ok');
      } return app.fetch(req,env,ctx);
    }};`},write:false,bundle:true,format:'esm',platform:'browser',external:['cloudflare:*','node:*']});
  const origin='https://app.a2aroom.com';
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text,
    compatibilityDate:'2026-11-19',compatibilityFlags:['nodejs_compat','global_fetch_strictly_public'],
    d1Databases:['DB'],kvNamespaces:['OAUTH_KV'],r2Buckets:['CHAT_MEDIA'],
    durableObjects:{PUSH:{className:'PushHub',useSQLite:true},DIRECTORY:{className:'DirectoryHub',useSQLite:true}},
    serviceBindings:{ASSETS:()=>new Response('')},bindings:{ENVIRONMENT:'production',PUBLIC_ORIGIN:origin,
      DIRECTORY_ORIGIN:'https://a2aroom.com',PRIVATE_BETA:'false',PUBLIC_ACCESS:'true',OWNER_ACCOUNT:'host'}}));
  t.after(()=>mf.dispose());
  const db=await mf.getD1Database('DB');
  for (const file of (await readdir('migrations')).sort())
    await db.batch(unstable_splitSqlQuery(await readFile('migrations/'+file,'utf8')).map(sql=>db.prepare(sql)));
  const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
  await db.batch([
    db.prepare("INSERT INTO users(id,account_name,email,created_at) VALUES('host','host','host@example.test',0),('author','author','author@example.test',0)"),
    db.prepare("INSERT INTO sessions VALUES(?,'host','csrf',?,0),(?,'author','csrf',?,0)").bind(hash('host-session'),Date.now()+3600000,hash('author-session'),Date.now()+3600000),
    db.prepare("INSERT INTO rooms(id,host_user_id,name,visibility,access_mode,directory_listed,created_at) VALUES('open','host','Open','public','anonymous',1,0),('private','host','Private','invite','invite',0,0)"),
    db.prepare("INSERT INTO room_members(id,room_id,user_id,kind,joined_at) VALUES('host-m','private','host','human',0),('author-m','private','author','human',0)"),
    db.prepare("INSERT INTO messages(id,room_id,author_user_id,body,created_at) VALUES('authored','private','author','Original',0),('deletable','private','author','Delete me',0)"),
  ]);
  const call=(who:string,method:string,path:string,body?:unknown)=>mf.dispatchFetch(origin+'/api'+path,{method,headers:{Origin:origin,
    Cookie:'__Host-a2aroom_session='+who+'-session','X-CSRF-Token':'csrf','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  assert.equal((await call('author','PATCH','/messages/authored',{body:'Before ban'})).status,200);
  assert.equal((await call('host','DELETE','/rooms/private/members/author-m')).status,200);
  assert.equal((await call('author','POST','/rooms/private/messages',{body:'After ban'})).status,403);
  assert.equal((await call('author','PATCH','/messages/authored',{body:'After ban'})).status,404);
  assert.equal(await db.prepare("SELECT body FROM messages WHERE id='authored'").first('body'),'Before ban');
  assert.equal((await call('author','DELETE','/messages/deletable')).status,200);

  const jpeg=Buffer.alloc(40000); Buffer.from([255,216,255,192,0,8,8,0,1,0,1,1]).copy(jpeg); jpeg[39998]=255; jpeg[39999]=217;
  async function guest() {
    const response=await mf.dispatchFetch(origin+'/api/public/rooms/open/session',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},
      body:JSON.stringify({image:{mime:'image/jpeg',data:jpeg.toString('base64')}})});
    assert.equal(response.status,201);
    const data=await response.json() as {user_id:string;csrf:string};
    return {...data,cookie:response.headers.get('Set-Cookie')!.split(';')[0]};
  }
  const expired=await guest(), active=await guest(), left=await guest();
  await db.batch([
    db.prepare("INSERT INTO messages(id,room_id,author_user_id,body,created_at) VALUES('guest-history','open',?,'Preserve history',0)").bind(expired.user_id),
    db.prepare('UPDATE guest_sessions SET expires_at=0 WHERE user_id=?').bind(expired.user_id),
    db.prepare("INSERT INTO guest_sessions(token_hash,user_id,room_id,csrf_token,expires_at,created_at) VALUES('old-session',?,'open','old-csrf',0,0)")
      .bind(active.user_id),
  ]);
  const end=await mf.dispatchFetch(origin+'/api/public/rooms/open/session/end',{method:'POST',headers:{Origin:origin,Cookie:left.cookie,'X-CSRF-Token':left.csrf}});
  assert.equal(end.status,200);
  assert.equal(await db.prepare('SELECT count(*) n FROM profile_images WHERE owner_id=?').bind(left.user_id).first('n'),0);
  // A previously orphaned image is collected too, without deleting its author or history.
  await db.prepare("INSERT INTO profile_images(kind,subject_id,owner_id,mime_type,image_data,updated_at) VALUES('user',?,?,'image/jpeg',?,0)")
    .bind(left.user_id,left.user_id,new Uint8Array([1])).run();
  assert.equal((await mf.dispatchFetch(origin+'/__test_scheduled')).status,200);
  for (const id of [expired.user_id,left.user_id]) {
    assert.equal(await db.prepare('SELECT count(*) n FROM profile_images WHERE owner_id=?').bind(id).first('n'),0);
    assert.equal(await db.prepare('SELECT count(*) n FROM guest_sessions WHERE user_id=?').bind(id).first('n'),0);
    assert.equal(await db.prepare('SELECT count(*) n FROM room_members WHERE user_id=?').bind(id).first('n'),0);
    assert.equal(await db.prepare('SELECT count(*) n FROM users WHERE id=?').bind(id).first('n'),1);
  }
  assert.equal(await db.prepare("SELECT body FROM messages WHERE id='guest-history'").first('body'),'Preserve history');
  assert.equal(await db.prepare('SELECT count(*) n FROM profile_images WHERE owner_id=?').bind(active.user_id).first('n'),1);
  assert.equal(await db.prepare('SELECT count(*) n FROM guest_sessions WHERE user_id=?').bind(active.user_id).first('n'),1);
  assert.equal(await db.prepare('SELECT count(*) n FROM room_members WHERE user_id=?').bind(active.user_id).first('n'),1);
});
