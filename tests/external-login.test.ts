import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { unstable_splitSqlQuery } from 'wrangler';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

test('External providers register, link and authenticate users while reserving the Google operator identity', async t => {
  const origin = 'https://app.a2aroom.com';
  const bundle = await build({entryPoints:['server/index.ts'],bundle:true,write:false,platform:'browser',format:'esm',external:['cloudflare:*','node:*']});
  const pair = await generateKeyPair('RS256');
  const key = {...await exportJWK(pair.publicKey),kid:'fixture',alg:'RS256'};
  let auth: URL;
  let subject = 'owner-subject';
  let email='member@example.test', verified=true;
  let badNonce = false;
  const mf = new Miniflare(convertV4MiniflareOptions({ modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-11-19',
    compatibilityFlags:['nodejs_compat','global_fetch_strictly_public'],d1Databases:['DB'],kvNamespaces:['OAUTH_KV'],
    bindings:{PUBLIC_ORIGIN:origin,DIRECTORY_ORIGIN:"https://a2aroom.com",ENVIRONMENT:'production',OWNER_ACCOUNT:'examplehost',PRIVATE_BETA:'false',PUBLIC_ACCESS:'true',OWNER_GOOGLE_EMAIL_HASH:createHash('sha256').update('operator@example.com').digest('hex'),
      GOOGLE_CLIENT_ID:'google-fixture',GOOGLE_CLIENT_SECRET:'fixture',CHATGPT_CLIENT_ID:'chatgpt-fixture',CHATGPT_CLIENT_SECRET:'chat-secret',TIKTOK_CLIENT_KEY:'tik-key',TIKTOK_CLIENT_SECRET:'tik-secret'},
    outboundService:async req => {
      if (req.method === 'GET') return Response.json({keys:[key]});
      const body = new URLSearchParams(await req.text());
      if (new URL(req.url).hostname === 'open.tiktokapis.com') {
        assert.equal(req.headers.get('Content-Type'),'application/x-www-form-urlencoded');
        assert.equal(body.get('client_key'),'tik-key');
        assert.equal(body.get('client_secret'),'tik-secret');
        return Response.json({open_id:subject,access_token:'fixture-tiktok-access'});
      }
      if (new URL(req.url).hostname === 'auth.openai.com')
        assert.equal(req.headers.get('Authorization'),'Basic '+btoa('chatgpt-fixture:chat-secret'));
      assert.equal(createHash('sha256').update(body.get('code_verifier')!).digest('base64url'),auth.searchParams.get('code_challenge'));
      const issuer = auth.origin;
      const jwt = await new SignJWT({ email, email_verified:verified, nonce:badNonce?'wrong':auth.searchParams.get('nonce') }).setProtectedHeader({alg:'RS256',kid:'fixture'})
        .setSubject(subject).setIssuer(issuer).setAudience(body.get('client_id')!).setIssuedAt().setExpirationTime('5m').sign(pair.privateKey);
      return Response.json({id_token:jwt});
    },
  }));
  t.after(()=>mf.dispose());
  const db = await mf.getD1Database('DB');
  for (const file of (await readdir('migrations')).sort()) await db.batch(unstable_splitSqlQuery(await readFile('migrations/'+file,'utf8')).map(q=>db.prepare(q)));
  const post=(path:string,body:unknown,cookie='',csrf='')=>mf.dispatchFetch(origin+'/api/'+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',Cookie:cookie,'X-CSRF-Token':csrf},body:JSON.stringify(body)});
  async function start(next='/') {
    const r=await post('external/google/start',{mode:'login',next});
    assert.equal(r.status,200);
    auth=new URL((await r.json() as {url:string}).url);
    assert.equal(auth.searchParams.get('scope'),'openid email');
    const cookie=r.headers.get('set-cookie')!.split(';')[0];
    const url=auth.searchParams.get('redirect_uri')+'?code=example&state='+auth.searchParams.get('state');
    return (browser=cookie)=>mf.dispatchFetch(url,{headers:{Cookie:browser},redirect:'manual'});
  }
  async function pending(next='/') {
    const cb=await start(next);
    assert.match((await cb('')).headers.get('location')!,/failed/);
    const r=await cb();
    const id=new URL(r.headers.get('location')!,origin).searchParams.get('google_link');
    assert.ok(id);
    assert.match((await cb()).headers.get('location')!,/failed/);
    return {path:'external/google/confirmation/'+id,cookie:r.headers.get('set-cookie')!.split(';')[0]};
  }
  verified=false;
  assert.match((await (await start())()).headers.get('location')!,/failed/);
  verified=true; badNonce=true;
  assert.match((await (await start())()).headers.get('location')!,/failed/);
  badNonce=false;
  const member=await pending('/rooms/example');
  assert.equal((await post(member.path,{account:'examplehost'},member.cookie)).status,403);
  assert.equal((await post(member.path,{account:'member'})).status,410);
  const registered=await post(member.path,{account:'member'},member.cookie);
  assert.equal(registered.status,200);
  assert.deepEqual(await registered.json(),{next:'/rooms/example'});
  assert.equal((await post(member.path,{account:'member'},member.cookie)).status,410);
  assert.equal((await (await start())()).headers.get('location'),'/inbox');
  subject='second';
  const second=await pending();
  assert.equal((await post(second.path,{account:'member'},second.cookie)).status,409);
  assert.equal((await post(second.path+'/cancel',{},second.cookie)).status,200);
  assert.equal((await post(second.path,{account:'other'},second.cookie)).status,410);
  email='operator@example.com'; subject='owner';
  const admin=await pending();
  const preview=await mf.dispatchFetch(origin+'/api/'+admin.path,{headers:{Cookie:admin.cookie}});
  assert.deepEqual(await preview.json(),{account:'examplehost'});
  assert.equal((await post(admin.path,{account:'other'},admin.cookie)).status,403);
  const created=await post(admin.path,{account:'examplehost'},admin.cookie);
  assert.equal(created.status,200);
  const cb=await (await start())();
  const session=cb.headers.getSetCookie().find(x=>x.startsWith('__Host-a2aroom_session='))!;
  const state=await mf.dispatchFetch(origin+'/api/session',{headers:{Cookie:session.split(';')[0]}});
  assert.equal((await state.json() as {operator:boolean}).operator,true);
  async function socialCallback(p: 'tiktok'|'chatgpt', cookie='', csrf='') {
    const start = await post('external/'+p+'/start',{mode:cookie?'link':'login'},cookie,csrf);
    assert.equal(start.status,200);
    auth = new URL((await start.json() as {url:string}).url);
    assert.equal(auth.searchParams.get('scope'),p === 'tiktok' ? 'user.info.basic' : 'openid profile email');
    const browser = start.headers.get('set-cookie')!.split(';')[0];
    const callback = auth.searchParams.get('redirect_uri')+'?code=test&state='+auth.searchParams.get('state');
    return mf.dispatchFetch(callback,{headers:{Cookie:[cookie,browser].filter(Boolean).join('; ')},redirect:'manual'});
  }
  const googleCookie=registered.headers.getSetCookie().find(c=>c.startsWith('__Host-a2aroom_session='))!.split(';')[0];
  const memberSession=await mf.dispatchFetch(origin+'/api/session',{headers:{Cookie:googleCookie}});
  const {csrf}=await memberSession.json() as {csrf:string};
  for (const p of ['chatgpt','tiktok'] as const) {
    subject='same-external-subject';
    if (p === 'chatgpt') {
      badNonce=true;
      assert.match((await socialCallback(p)).headers.get('location')!,/failed/);
      badNonce=false;
    }
    const cb=await socialCallback(p);
    const id=new URL(cb.headers.get('location')!,origin).searchParams.get(p+'_link');
    assert.ok(id);
    const path='external/'+p+'/confirmation/'+id;
    const cookie=cb.headers.getSetCookie().at(-1)!.split(';')[0];
    assert.equal((await post(path,{account:'examplehost'},cookie)).status,403);
    assert.equal((await post(path,{account:p+'-member'},cookie)).status,200);
    assert.equal((await post(path,{account:'again'},cookie)).status,410);
    assert.equal((await socialCallback(p)).headers.get('location'),'/inbox');
    assert.match((await socialCallback(p,googleCookie,csrf)).headers.get('location')!,/failed/);
    subject='explicit-link';
    assert.match((await socialCallback(p,googleCookie,csrf)).headers.get('location')!,/external=linked/);
    const again=await socialCallback(p);
    const linkedCookie=again.headers.getSetCookie().find(c=>c.startsWith('__Host-a2aroom_session='))!.split(';')[0];
    const account=await mf.dispatchFetch(origin+'/api/session',{headers:{Cookie:linkedCookie}});
    assert.equal((await account.json() as {user:{account_name:string}}).user.account_name,'member');
  }

});
