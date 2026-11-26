import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { unstable_splitSqlQuery } from 'wrangler';

test('scheduled rate cleanup removes expired rows in bounded batches and preserves active limits', async t => {
  const bundle = await build({stdin:{contents:`
    import { cleanupRateLimits } from './server/rate-limit-cleanup';
    import { enforceIpRate } from './server/security';
    export default { async fetch(request, env) {
      if (new URL(request.url).pathname === '/cleanup') {
        await cleanupRateLimits(env, Number(new URL(request.url).searchParams.get('now')));
        return new Response('ok');
      }
      try { await enforceIpRate(env, request, 'test', 1, 86400000); return new Response('ok'); }
      catch { return new Response('limited', {status:429}); }
    }};`,resolveDir:process.cwd(),loader:'ts'},write:false,bundle:true,format:'esm',platform:'browser',external:['cloudflare:*','node:*']});
  const worker = new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text,
    compatibilityDate:'2026-11-19',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],bindings:{ENVIRONMENT:'development'}}));
  t.after(() => worker.dispose());
  const db = await worker.getD1Database('DB');
  await db.batch([
    db.prepare('CREATE TABLE login_attempts(id INTEGER PRIMARY KEY, subject_hash TEXT NOT NULL, created_at INTEGER NOT NULL)'),
    db.prepare('CREATE TABLE agent_requests(id INTEGER PRIMARY KEY, agent_id TEXT NOT NULL, created_at INTEGER NOT NULL)'),
    ...unstable_splitSqlQuery(await readFile('migrations/0034_rate_limit_cleanup.sql','utf8')).map(sql=>db.prepare(sql)),
  ]);
  const now=Date.now(), cutoff=now-48*3600_000;
  await db.batch([
    db.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<10001)
      INSERT INTO login_attempts(subject_hash,created_at) SELECT 'old',? FROM n`).bind(cutoff-1),
    db.prepare("INSERT INTO login_attempts(subject_hash,created_at) VALUES ('boundary',?)").bind(cutoff),
    db.prepare("INSERT INTO agent_requests(agent_id,created_at) VALUES ('old',?),('active',?)").bind(cutoff-1,now),
  ]);
  assert.equal((await worker.dispatchFetch('http://localhost/check')).status,200);
  assert.equal((await worker.dispatchFetch('http://localhost/check')).status,429);
  assert.equal((await worker.dispatchFetch('http://localhost/cleanup?now='+now)).status,200);
  assert.equal(await db.prepare("SELECT COUNT(*) n FROM login_attempts WHERE subject_hash='old'").first('n'),1);
  assert.equal(await db.prepare("SELECT COUNT(*) n FROM login_attempts WHERE subject_hash='boundary'").first('n'),1);
  assert.equal(await db.prepare('SELECT COUNT(*) n FROM agent_requests').first('n'),1);
  assert.equal((await worker.dispatchFetch('http://localhost/check')).status,429);
  await worker.dispatchFetch('http://localhost/cleanup?now='+now);
  assert.equal(await db.prepare("SELECT COUNT(*) n FROM login_attempts WHERE subject_hash='old'").first('n'),0);
});
