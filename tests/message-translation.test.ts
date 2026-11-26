import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { unstable_splitSqlQuery } from 'wrangler';

test('on-demand translations honor visibility, consent, revisions and inference limits', async t => {
  // Exercise the deployed HTTP routes and SQLite migrations, substituting only the inference binding.
  const bundled = await build({
    stdin: { resolveDir: process.cwd(), contents: `
      import worker from './server/index.ts';
      export default { fetch(req, env, ctx) {
        env.AI = { run: (model, input) => env.MODEL.fetch('https://fixture.test', {
          method: 'POST', body: JSON.stringify({model,input})
        }).then(r => r.json()) };
        return worker.fetch(req, env, ctx);
      } };
    ` },
    bundle: true, write: false, platform: 'browser', format: 'esm', external: ['node:*', 'cloudflare:*'],
  });
  const origin = 'https://app.a2aroom.com';
  let calls = 0;
  let finish = 'stop';
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: bundled.outputFiles[0].text, d1Databases: ['DB'], kvNamespaces: ['OAUTH_KV'],
    compatibilityDate: '2026-11-19', compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'],
    bindings: { ENVIRONMENT: 'production', PUBLIC_ORIGIN: origin, DIRECTORY_ORIGIN: 'https://a2aroom.com',
      PRIVATE_BETA: 'false', PUBLIC_ACCESS: 'true', OWNER_ACCOUNT: 'alice' },
    serviceBindings: { MODEL: async request => {
      const { model, input } = await request.json() as {model: string; input: {messages: {role: string; content: string}[]; max_completion_tokens: number}};
      assert.equal(model, '@cf/google/gemma-4-26b-a4b-it');
      assert.equal(input.messages.length, 2);
      assert.ok(input.max_completion_tokens <= 4096);
      calls++;
      return Response.json({choices: [{message: {content: 'Translation ' + input.messages[1].content}, finish_reason: finish}]});
    } },
  }));
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  for (const file of (await readdir('migrations')).sort()) {
    await db.batch(unstable_splitSqlQuery(await readFile('migrations/' + file, 'utf8')).map(sql => db.prepare(sql)));
  }
  const alice = '__Host-a2aroom_session=alice-session', bob = '__Host-a2aroom_session=bob-session';
  const guestToken = 'g'.repeat(43), guest = '__Host-a2aroom_guest_r=' + guestToken;
  const hash = (token: string) => createHash('sha256').update(token).digest('hex');
  const future = Date.now() + 60_000;
  await db.batch([
    db.prepare("INSERT INTO users(id,account_name,email,created_at,is_guest) VALUES('a','alice','a@example.test',1,0),('b','bob','b@example.test',1,0),('g','guest-fixture','g@example.test',1,1)"),
    db.prepare("INSERT INTO rooms(id,host_user_id,name,visibility,access_mode,directory_listed,created_at) VALUES('r','a','Chat','public','anonymous',1,0)"),
    db.prepare("INSERT INTO room_members(id,room_id,user_id,kind,joined_at) VALUES('ma','r','a','human',0),('mg','r','g','human',0)"),
    db.prepare("INSERT INTO messages(id,room_id,body,author_user_id,created_at) VALUES('m','r','guest greeting','g',0)"),
    db.prepare("INSERT INTO sessions VALUES(?,'a','csrf',?,0),(?,'b','csrf',?,0)").bind(hash('alice-session'), future, hash('bob-session'), future),
    db.prepare("INSERT INTO guest_sessions (token_hash,user_id,room_id,csrf_token,expires_at,created_at) VALUES(?,'g','r','guestcsrf',?,0)").bind(hash(guestToken),future),
  ]);
  const translate = (preview: boolean, cookie = '', consent = false, edited_at: number | null = null, target = 'ja') => {
    return mf.dispatchFetch(origin + '/api/' + (preview ? 'public/' : '') + 'rooms/r/messages/m/translation', {
      method: 'POST', headers: {Origin: origin, 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': 'csrf'},
      body: JSON.stringify({target, edited_at, consent}),
    });
  };
  const initial = await translate(true);
  assert.equal(initial.status, 200);
  assert.deepEqual(await initial.json(), {translation: 'Translation guest greeting'});
  assert.equal((await translate(true, guest)).status, 200);
  assert.equal((await translate(false, alice)).status, 200);
  assert.equal(calls, 1);
  await db.prepare("INSERT INTO blocks VALUES('b','g',0)").run();
  assert.equal((await translate(true, bob)).status, 404);
  await db.prepare("UPDATE rooms SET visibility='invite', access_mode='invite', directory_listed=0 WHERE id='r'").run();
  assert.equal((await translate(true)).status, 404);
  assert.equal((await translate(false, bob, true)).status, 404);
  assert.equal((await translate(false, alice)).status, 428);
  assert.equal((await translate(false, alice, true)).status, 200);
  assert.equal(calls, 1);
  await db.prepare("UPDATE messages SET body='edited greeting', edited_at=25 WHERE id='m'").run();
  assert.equal((await translate(false, alice, true)).status, 409);
  assert.equal((await translate(false, alice, false, 25)).status, 428);
  assert.equal(calls, 1);
  const edited = await translate(false, alice, true, 25);
  assert.deepEqual(await edited.json(), {translation: 'Translation edited greeting'});
  assert.equal(calls, 2);
  finish = 'length';
  assert.equal((await translate(false, alice, true, 25, 'en')).status, 503);
  finish = 'stop';
  await db.prepare('UPDATE translation_budget SET reserved_units=400000').run();
  assert.equal((await translate(false, alice, true, 25, 'en')).status, 429);
  assert.equal(calls, 3);
  assert.equal((await translate(false, alice, true, 25)).status, 200);
  await db.prepare('UPDATE translation_budget SET utc_day=utc_day-1').run();
  assert.equal((await translate(false, alice, true, 25, 'en')).status, 200);
  assert.equal(calls, 4);
  await db.prepare("UPDATE messages SET deleted_at=30 WHERE id='m'").run();
  assert.equal((await translate(false, alice, true, 25)).status, 404);
  assert.equal(await db.prepare('SELECT count(*) AS n FROM message_translations').first('n'), 0);
});
