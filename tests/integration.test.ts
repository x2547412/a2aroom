import { strict as assert } from 'node:assert';
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const root = process.cwd();
const wrangler = path.join(root, 'node_modules/.bin/wrangler');
const bootstrap = 'synthetic-bootstrap-for-integration-only';
const password = 'synthetic-password-for-integration-only';
const callHeaders = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };

function syntheticPng(size: number): Buffer {
  function chunk(name: string, data: Buffer): Buffer {
    const type = Buffer.from(name, 'ascii'); const content = Buffer.concat([type, data]);
    let crc = 0xffffffff;
    for (const byte of content) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const output = Buffer.alloc(data.length + 12);
    output.writeUInt32BE(data.length, 0); content.copy(output, 4); output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, data.length + 8);
    return output;
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let row = 0; row < size; row++) randomBytes(size * 4).copy(rows, row * (size * 4 + 1) + 1);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function seedSession(fixture: {state:string; configPath:string}, account:string) {
  const token=randomBytes(32).toString('hex'), csrf=randomBytes(24).toString('hex');
  const hash=createHash('sha256').update(token).digest('hex');
  assert.match(account,/^[a-z-]+$/);
  const query=`INSERT INTO users(id,account_name,email,created_at) VALUES('${account}','${account}','${account}@example.test',0);
    INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,created_at) VALUES('${hash}','${account}','${csrf}',${Date.now()+3600000},0);`;
  const result=spawnSync(wrangler,['d1','execute','a2aroom-test','--local','--persist-to',fixture.state,'--config',fixture.configPath,'--command',query],{cwd:root,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  return {cookie:'__Host-a2aroom_session='+token,csrf};
}

async function startFixture(options: { publicAccess?: boolean } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'a2aroom-test-'));
  const state = path.join(directory, 'state');
  const assets = path.join(directory, 'assets');
  await mkdir(path.join(assets, 'agent-skill'), { recursive: true });
  await writeFile(path.join(assets, 'index.html'), '<!doctype html><title>fixture</title>');
  await writeFile(path.join(assets, 'agent-skill', 'SKILL.md'), await readFile(path.join(root, 'public/agent-skill/SKILL.md')));
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const base = JSON.parse(await readFile(path.join(root, 'wrangler.jsonc'), 'utf8'));
  const config = { ...base, name: 'a2aroom-test', main: path.join(root, 'server/index.ts'),
    assets: { ...base.assets, directory: assets },
    d1_databases: [{ ...base.d1_databases[0], database_name: 'a2aroom-test', migrations_dir: path.join(root, 'migrations') }],
    vars: { ...base.vars, ENVIRONMENT: 'development', PUBLIC_ORIGIN: origin, DEV_ORIGIN: origin, BOOTSTRAP_CODE: bootstrap,
      PRIVATE_BETA: options.publicAccess ? 'false' : 'true', PUBLIC_ACCESS: options.publicAccess ? 'true' : 'false' } };
  const configPath = path.join(directory, 'wrangler.json');
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const migration = spawnSync(wrangler, ['d1', 'migrations', 'apply', 'a2aroom-test', '--local', '--persist-to', state, '--config', configPath], { cwd: root, encoding: 'utf8', env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' } });
  if (migration.status !== 0) throw new Error(`Local migration failed: ${migration.stderr}`);
  const child: ChildProcess = spawn(wrangler, ['dev', '--local', '--test-scheduled', '--ip', '127.0.0.1', '--port', String(port), '--persist-to', state, '--config', configPath], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' } });
  let logs = '';
  child.stdout?.on('data', (value) => { logs += String(value); });
  child.stderr?.on('data', (value) => { logs += String(value); });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${origin}/api/session`)).ok) return { directory, child, origin, state, configPath }; } catch { /* startup retry */ }
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill('SIGTERM');
  throw new Error(`Local worker did not start: ${logs.slice(-3000)}`);
}

test('personal beta enforces identity, room membership, limits, bearer and OAuth revocation', { timeout: 120_000 }, async (t) => {
  const fixture = await startFixture();
  t.after(async () => {
    fixture.child.kill('SIGTERM');
    await new Promise<void>((resolve) => { if (fixture.child.exitCode !== null) resolve(); else fixture.child.once('exit', () => resolve()); });
    await rm(fixture.directory, { recursive: true, force: true });
  });
  const { origin } = fixture;
  let cookie = ''; let csrf = '';
  async function api(url: string, method = 'GET', body?: unknown, extra: Record<string, string> = {}) {
    const response = await fetch(`${origin}/api${url}`, { method, headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json() as Record<string, any>;
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return { response, data };
  }
  async function rpc(token: string, method: string, params: Record<string, unknown> = {}) {
    const response = await fetch(`${origin}/mcp`, { method: 'POST', headers: { ...callHeaders, Authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    return { response, data: await response.json() as Record<string, any> };
  }
  async function tool(token: string, name: string, args: Record<string, unknown> = {}) {
    const result = await rpc(token, 'tools/call', { name, arguments: args });
    assert.equal(result.response.status, 200);
    return result.data.result;
  }

  assert.equal((await api('/rooms')).response.status, 401);
  assert.equal((await api('/public/rooms')).response.status, 404);
  assert.equal((await api('/register', 'POST', { account: 'another', email: 'another@example.test', password })).response.status, 404);
  assert.equal((await api('/session')).data.needsSetup, false);
  const guide = await fetch(`${origin}/agent/guide`);
  assert.equal(guide.status, 200);
  assert.match(await guide.text(), /<html lang="en">/);
  const japanese = await fetch(`${origin}/agent/guide`, {headers: {'Accept-Language': 'en;q=0.4,ja-JP'}});
  assert.equal(japanese.headers.get('Content-Language'), 'ja');
  const localizedPage = await japanese.text();
  assert.match(localizedPage, /<pre lang="en" translate="no"># Read a public conversation/);
  assert.match(localizedPage, /aria-label="スキルをダウンロード"[^>]*><svg/);
  const legacyGuide = await fetch(origin+'/agent-skill/guide.ja.md',{redirect:'manual'});
  assert.equal(legacyGuide.headers.get('Location'),origin+'/agent-skill/SKILL.md');
  const download = await fetch(`${origin}/agent/skill-download`);
  assert.match(download.headers.get('Content-Disposition') ?? '', /attachment/);
  assert.match(await download.text(), /^---\nname: agent-skill/);
  for (const route of ['/setup','/login']) assert.equal((await api(route,'POST',{})).response.status,404);
  ({cookie,csrf}=seedSession(fixture,'examplehost'));

  const draft = await api('/rooms','POST',{name:'Private beta draft',access_mode:'anonymous',tags:['Music']});
  const catalog = () => fetch(origin+'/api/explore/rooms').then(r=>r.json()) as Promise<{rooms:Array<{id:string;tags:string[]}>;participation_open:boolean}>;
  assert.equal((await catalog()).rooms.length,0);
  await api('/rooms/'+draft.data.id+'/access','PATCH',{access_mode:'anonymous',directory_listed:true});
  const preview = await catalog();
  assert.equal(preview.participation_open,false);
  assert.deepEqual(preview.rooms.map(r=>r.tags),[['Music']]);
  assert.equal((await api('/explore/rooms')).data.rooms[0].participants,null);
  assert.deepEqual((await api('/directory/rooms')).data.rooms[0].participants,[{kind:'human',name:'examplehost'}]);
  assert.equal((await fetch(origin+'/api/public/rooms/'+draft.data.id+'/messages')).status,404);
  await api('/rooms/'+draft.data.id,'DELETE');
  assert.equal((await catalog()).rooms.length,0);

  // Simulate pre-existing outsiders, even though public registration is disabled.
  // Their otherwise valid credentials must still be rejected in the personal beta.
  const outsiderSession = 'synthetic-outsider-session';
  const outsiderToken = 'a2a_synthetic-outsider-token';
  const digest = (value: string) => createHash('sha256').update(value).digest('hex');
  const sql = `
    INSERT INTO users (id, account_name, email, created_at)
      VALUES ('outsider', 'outsider', 'outsider@example.test', 0);
    INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at, created_at)
      VALUES ('${digest(outsiderSession)}', 'outsider', 'outsider-csrf', ${Date.now() + 60_000}, 0);
    INSERT INTO agents (id, owner_id, name, handle, platform, created_at)
      VALUES ('outsider-agent', 'outsider', 'outsider agent', 'outsider', 'test', 0);
    INSERT INTO agent_connections (id, agent_id, label, kind, token_hash, created_at)
      VALUES ('outsider-connection', 'outsider-agent', 'test', 'token', '${digest(outsiderToken)}', 0);
  `;
  const seeded = spawnSync(wrangler, ['d1', 'execute', 'a2aroom-test', '--local', '--persist-to', fixture.state,
    '--config', fixture.configPath, '--command', sql], { cwd: root, encoding: 'utf8', env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' } });
  assert.equal(seeded.status, 0, seeded.stderr);
  const outsiderCookie = `__Host-a2aroom_session=${outsiderSession}`;
  const outsiderView = await fetch(`${origin}/api/session`, { headers: { Cookie: outsiderCookie } });
  assert.equal((await outsiderView.json() as { authenticated: boolean }).authenticated, false);
  assert.equal((await fetch(`${origin}/api/rooms`, { headers: { Cookie: outsiderCookie } })).status, 401);
  assert.equal((await rpc(outsiderToken, 'tools/list')).response.status, 401);

  assert.equal((await api('/agents', 'POST', { name: 'Bad origin', platform: 'test' }, { Origin: 'https://untrusted.invalid' })).response.status, 403);
  const noCsrf = await fetch(`${origin}/api/rooms`, { method: 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'invalid' }) });
  assert.equal(noCsrf.status, 403);

  for (const operation of ['start', 'check', 'approve', 'cancel']) {
    const url = `${origin}/api/device/${operation}`;
    const unauthenticated = await fetch(url, { method: 'POST', headers: { Origin: origin } });
    assert.equal(unauthenticated.status, 401);
    const authenticated = await fetch(url, { method: 'POST', headers: { Origin: origin, Cookie: cookie, 'X-CSRF-Token': csrf } });
    assert.ok([404, 405].includes(authenticated.status));
    assert.equal(authenticated.headers.get('set-cookie'), null);
  }

  const firstAgent = await api('/agents', 'POST', { name: 'Muse test', handle: 'muse', platform: 'Muse' });
  const secondAgent = await api('/agents', 'POST', { name: 'Dot test', handle: 'dot', platform: 'ChatGPT Dot' });
  assert.equal(firstAgent.response.status, 201); assert.equal(secondAgent.response.status, 201);
  const room = await api('/rooms', 'POST', { name: 'Test room', description: '', visibility: 'public' });
  assert.equal(room.response.status, 201);
  assert.equal((await api(`/rooms/${room.data.id}/agents`, 'POST', { agent_id: firstAgent.data.id })).response.status, 201);
  const tokenResponse = await api(`/agents/${firstAgent.data.id}/connections`, 'POST', { label: 'test connector' });
  const token = tokenResponse.data.token as string;
  assert.match(token, /^a2a_/);
  const ownId = (await api('/session')).data.user.id as string;
  const rename = await api('/account/id','PATCH',{previous:'examplehost',account_name:'room-owner'});
  assert.equal(rename.response.status,403);
  assert.equal(rename.data.error,'ACCOUNT_ID_FIXED');
  assert.equal((await api('/session')).data.user.account_name,'examplehost');
  const imageData = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const imageBody = { mime: 'image/png', data: imageData };
  assert.equal((await api(`/images/user/${ownId}`, 'PUT', imageBody)).response.status, 200);
  assert.equal((await api(`/images/agent/${firstAgent.data.id}`, 'PUT', imageBody)).response.status, 200);
  assert.equal((await api(`/images/platform/${firstAgent.data.id}`, 'PUT', imageBody)).response.status, 200);
  assert.equal((await api('/images')).data.images.length, 3);
  const imageReply = await fetch(`${origin}/api/images/agent/${firstAgent.data.id}`, { headers: { Cookie: cookie } });
  assert.equal(imageReply.status, 200);
  assert.equal(imageReply.headers.get('Content-Type'), 'image/png');
  assert.equal(Buffer.from(await imageReply.arrayBuffer()).toString('base64'), imageData);
  assert.equal((await fetch(`${origin}/api/images/agent/${firstAgent.data.id}`)).status, 401);
  assert.equal((await api('/images/user/outsider', 'PUT', imageBody)).response.status, 403);
  assert.equal((await api('/images/agent/outsider-agent', 'PUT', imageBody)).response.status, 404);
  assert.equal((await api(`/images/user/${ownId}`, 'PUT', { mime: 'image/png', data: 'YWJj' })).response.status, 400);
  assert.equal((await api(`/images/platform/${firstAgent.data.id}`, 'DELETE')).response.status, 200);
  assert.equal((await api('/images')).data.images.length, 2);
  const exposed = await api('/agents');
  assert.equal(JSON.stringify(exposed.data).includes(token), false);

  const forbidden = await fetch(`${origin}/api/rooms`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ name: 'not allowed' }) });
  assert.equal(forbidden.status, 403);
  const forbiddenPolicy = await fetch(`${origin}/api/agents/${firstAgent.data.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ daily_limit: 200 }) });
  assert.equal(forbiddenPolicy.status, 403);
  const init = await rpc(token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.response.status, 200);
  const tools = await rpc(token, 'tools/list');
  const toolNames=tools.data.result.tools.map((tool:{name:string})=>tool.name);
  for (const name of ['post_media_message','set_profile','get_room','leave_room','create_room_invite','remove_room_member','delete_room','preview_public_room']) assert.ok(toolNames.includes(name),name);
  assert.equal(new Set(toolNames).size,toolNames.length);
  assert.ok(tools.data.result.tools.some((item: {name:string}) => item.name === 'update_room'));
  assert.doesNotMatch(JSON.stringify(tools.data.result.tools), /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u);
  const createArgs={name:'Agent room', request_id:crypto.randomUUID()};
  const created=JSON.parse((await tool(token,'create_room',createArgs)).content[0].text);
  assert.ok(created.room_id,JSON.stringify(created));
  assert.equal(JSON.parse((await tool(token,'create_room',createArgs)).content[0].text).room_id,created.room_id);
  assert.equal((await api('/rooms/'+created.room_id)).response.status,403);
  assert.equal((await api('/rooms/'+created.room_id+'/join','POST')).response.status,200);
  assert.equal((await api('/rooms/'+created.room_id)).data.members.length,2);
  const extraRooms: string[] = [];
  for (let i = 1; i < 10; i++) {
    const extra = await tool(token, 'create_room', { name: 'Quota fixture', request_id: crypto.randomUUID() });
    assert.ok(!extra.isError);
    extraRooms.push(JSON.parse(extra.content[0].text).room_id);
  }
  const nextRoom = { name: 'Pending room', request_id: crypto.randomUUID() };
  const blocked = await tool(token, 'create_room', nextRoom);
  assert.ok(blocked.isError);
  const limit = JSON.parse(blocked.content[0].text);
  assert.equal(limit.error, 'ROOM_CREATION_LIMIT');
  assert.ok(Math.abs(Date.parse(limit.retry_at) - Date.now() - 86400_000) < 60_000);
  assert.equal(JSON.parse((await tool(token, 'create_room', createArgs)).content[0].text).room_id, created.room_id);
  for (const roomId of extraRooms) await api('/rooms/' + roomId, 'DELETE');
  const retried = JSON.parse((await tool(token, 'create_room', nextRoom)).content[0].text);
  assert.ok(retried.room_id);
  await api('/rooms/' + retried.room_id, 'DELETE');
  await api('/rooms/'+created.room_id,'DELETE');
  await api('/agents/'+firstAgent.data.id,'PATCH',{autonomous_rooms:false});
  assert.equal((await tool(token,'create_room',{...createArgs,request_id:crypto.randomUUID()})).isError,true);
  const resources = await rpc(token, 'resources/list');
  assert.equal(resources.data.result.resources[0].uri, 'guide://agent-skill/SKILL.md');
  const resource = await rpc(token, 'resources/read', { uri: 'guide://agent-skill/SKILL.md' });
  assert.match(resource.data.result.contents[0].text, /^---\nname: agent-skill/);
  const unreadTool = tools.data.result.tools.find((item: { name: string }) => item.name === 'get_unread');
  assert.equal(unreadTool.annotations.readOnlyHint, false);
  assert.equal(tools.data.result.tools.find((item: { name: string }) => item.name === 'read_messages').annotations.readOnlyHint, false);
  assert.equal((await tool(token, 'read_messages', { room_id: 'not-a-member' })).isError, true);

  // Image writes are bound to the authenticated agent, and a normal image can exceed the old 32 KiB MCP limit.
  const largePng = syntheticPng(96); const largeImageData = largePng.toString('base64');
  assert.ok(largeImageData.length > 32_768 && largePng.length <= 40_000);
  assert.equal((await api(`/images/agent/${secondAgent.data.id}`, 'PUT', imageBody)).response.status, 200);
  const upload = await tool(token, 'set_my_image', { kind: 'agent', mime: 'image/png', data: largeImageData });
  assert.equal(Boolean(upload.isError), false);
  assert.equal(JSON.parse(upload.content[0].text).kind, 'agent');
  const uploaded = await fetch(`${origin}/api/images/agent/${firstAgent.data.id}`, { headers: { Cookie: cookie } });
  assert.deepEqual(Buffer.from(await uploaded.arrayBuffer()), largePng);
  const mcpClient = new Client({ name: 'synthetic-image-client', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  try {
    await mcpClient.connect(transport);
    assert.equal((await mcpClient.listTools()).tools.some((item) => item.name === 'set_my_image'), true);
    assert.equal(Boolean((await mcpClient.callTool({ name: 'set_my_image', arguments: { kind: 'platform', ...imageBody } })).isError), false);
  } finally { await mcpClient.close(); }
  assert.equal((await tool(token, 'set_my_image', { kind: 'user', ...imageBody })).isError, true);
  assert.equal((await tool(token, 'set_my_image', { kind: 'agent', agent_id: secondAgent.data.id, ...imageBody })).isError, true);
  assert.equal((await tool(token, 'set_my_image', { kind: 'agent', mime: 'image/png', data: 'YWJj' })).isError, true);
  assert.equal((await tool(token, 'set_my_image', { kind: 'agent', mime: 'image/png', data: Buffer.alloc(40_001).toString('base64') })).isError, true);
  const secondBefore = await fetch(`${origin}/api/images/agent/${secondAgent.data.id}`, { headers: { Cookie: cookie } });
  assert.equal(Buffer.from(await secondBefore.arrayBuffer()).toString('base64'), imageData);
  const ownerBefore = await fetch(`${origin}/api/images/user/${ownId}`, { headers: { Cookie: cookie } });
  assert.equal(Buffer.from(await ownerBefore.arrayBuffer()).toString('base64'), imageData);
  assert.equal(JSON.parse((await tool(token, 'remove_my_image', { kind: 'platform' })).content[0].text).removed, true);
  assert.equal(JSON.parse((await tool(token, 'remove_my_image', { kind: 'platform' })).content[0].text).removed, false);
  assert.equal((await tool(token, 'remove_my_image', { kind: 'agent', agent_id: secondAgent.data.id })).isError, true);

  async function stream(last?: string) {
    const abort = new AbortController();
    const response = await fetch(origin + '/mcp', { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]),
      headers: { Authorization: 'Bearer ' + token, Accept: 'text/event-stream', ...(last ? { 'Last-Event-ID': last } : {}) } });
    assert.equal(response.status, 200);
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    async function frame() {
      while (!buffer.includes('\n\n')) {
        const part = await reader.read();
        assert.equal(part.done, false);
        buffer += part.value;
      }
      const end = buffer.indexOf('\n\n');
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      return frame;
    }
    return { abort, frame };
  }
  const hookPath = '/agents/' + firstAgent.data.id + '/webhook';
  assert.equal((await api(hookPath, 'PUT', { url: 'https://127.0.0.1/private' })).response.status, 400);
  assert.equal((await fetch(origin + '/api' + hookPath, { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } })).status, 403);
  const setHook = (url:string) => tool(token,'set_my_webhook',{url});
  assert.ok((await setHook('http://localhost')).isError);
  const key = async () => JSON.parse((await setHook('https://8.8.8.8/hook')).content[0].text).secret;
  const initialKey = await key();
  assert.ok(initialKey);
  assert.notEqual(await key(),initialKey);
  assert.deepEqual(JSON.parse((await tool(token,'get_my_webhook',{})).content[0].text),
    {configured:true,enabled:true,origin:'https://8.8.8.8'});
  assert.equal((await api(hookPath)).data.hook.url,'https://8.8.8.8/hook');
  assert.ok(!(await tool(token,'remove_my_webhook',{})).isError);
  assert.equal((await api(hookPath)).data.hook,null);
  const live = await stream();
  const priming = await live.frame();
  const last = /^id: (.+)$/m.exec(priming)![1];
  const humanMessage = await api(`/rooms/${room.data.id}/messages`, 'POST', { body: '@examplehost/muse こんにちは' });
  assert.equal(humanMessage.response.status, 201);
  const frame = await live.frame();
  const notification = JSON.parse(/^data: (.+)$/m.exec(frame)![1]);
  assert.equal(notification.method, 'notifications/a2aroom/new_message');
  assert.ok(Number.isSafeInteger(notification.params.seq));
  assert.deepEqual(notification.params, { event: 'new_message', room_id: room.data.id, seq: notification.params.seq,
    mentioned: true, message_id: humanMessage.data.id });
  live.abort.abort();
  const replay = await stream(last);
  await replay.frame();
  assert.equal(await replay.frame(), frame);
  replay.abort.abort();
  assert.deepEqual((await api(`/rooms/${room.data.id}/messages`)).data.messages[0].read_by, []);
  assert.equal((await api(`/rooms/${room.data.id}/messages`, 'POST', { body: '@examplehost/muse こんにちは' })).response.status, 409);
  const unread = await tool(token, 'get_unread', { room_id: room.data.id });
  const unreadBody = JSON.parse(unread.content[0].text);
  assert.equal(unreadBody.messages.length, 1);
  assert.equal(unreadBody.messages[0].priority_mention, true);
  assert.deepEqual((await api(`/rooms/${room.data.id}/messages`)).data.messages[0].read_by.map((reader: { agent_id: string }) => reader.agent_id), [firstAgent.data.id]);
  const again = await tool(token, 'get_unread', { room_id: room.data.id });
  assert.equal(JSON.parse(again.content[0].text).messages.length, 0);
  assert.equal((await api(`/messages/${humanMessage.data.id}`, 'PATCH', { body: '@examplehost/muse 編集したメッセージ' })).response.status, 200);
  assert.deepEqual((await api(`/rooms/${room.data.id}/messages`)).data.messages[0].read_by, []);
  assert.equal(JSON.parse((await tool(token, 'read_messages', { room_id: room.data.id, limit: 1 })).content[0].text).messages.length, 1);
  assert.deepEqual((await api(`/rooms/${room.data.id}/messages`)).data.messages[0].read_by.map((reader: { agent_id: string }) => reader.agent_id), [firstAgent.data.id]);
  assert.equal(JSON.parse((await tool(token, 'get_unread', { room_id: room.data.id })).content[0].text).messages.length, 0);
  const status = async () => (await api(`/rooms/${room.data.id}/reply-status`)).data.agents;
  const preparing = (active: boolean) => tool(token, 'set_reply_status', { room_id: room.data.id, active });
  assert.deepEqual(await status(), []);
  assert.equal(Boolean((await preparing(true)).isError), false);
  assert.equal((await status())[0].id, firstAgent.data.id);
  await preparing(false);
  assert.deepEqual(await status(), []);
  await preparing(true);
  assert.equal((await api('/inbox/latest')).data.message, null);
  const agentPost = await tool(token, 'post_message', { room_id: room.data.id, body: 'エージェントからのテストです' });
  assert.equal(Boolean(agentPost.isError), false);
  assert.deepEqual(await status(), []);
  const displayed = await api(`/rooms/${room.data.id}/messages`);
  assert.equal(displayed.data.messages[1].author_agent_id, firstAgent.data.id);
  const incoming = (await api('/inbox/latest')).data.message;
  assert.equal(incoming.id, displayed.data.messages[1].id);
  assert.equal(incoming.sender, displayed.data.messages[1].agent_name);
  assert.equal((await api('/inbox/latest?after=' + incoming.seq)).data.message, null);
  const reactionArgs = { room_id: room.data.id, message_id: humanMessage.data.id };
  const react = async (emoji: string | null) => JSON.parse((await tool(token, 'set_reaction', { ...reactionArgs, emoji })).content[0].text).reactions;
  assert.deepEqual(await react('❤️'), [{ emoji: '❤️', count: 1, mine: true }]);
  assert.deepEqual(await react('❤️'), [{ emoji: '❤️', count: 1, mine: true }]);
  const humanReactions = await api(`/rooms/${room.data.id}/messages/${humanMessage.data.id}/reaction`, 'PUT', { emoji: '❤️' });
  assert.deepEqual(humanReactions.data.reactions, [{ emoji: '❤️', count: 2, mine: true }]);
  await react('🎉');
  const reactionHistory = JSON.parse((await tool(token, 'read_messages', { room_id: room.data.id })).content[0].text);
  const current = reactionHistory.messages.find((m: {id: string}) => m.id === humanMessage.data.id);
  assert.deepEqual(current.reactions.find((r: {mine: boolean}) => r.mine), { emoji: '🎉', count: 1, mine: true });
  assert.deepEqual(await react(null), [{ emoji: '❤️', count: 1, mine: false }]);
  assert.equal((await tool(token, 'set_reaction', { ...reactionArgs, room_id: 'wrong', emoji: '❤️' })).isError, true);
  await api(`/agents/${firstAgent.data.id}`, 'PATCH', { name: 'Renamed Muse', platform: 'Other' });
  const historical = await api(`/rooms/${room.data.id}/messages`);
  assert.equal(historical.data.messages[1].agent_name, 'Muse test');
  assert.equal(historical.data.messages[1].platform, 'Muse');
  assert.equal(historical.data.messages[1].current_agent_name, 'Renamed Muse');

  const invite = await api(`/rooms/${room.data.id}/invites`, 'POST');
  assert.equal(invite.response.status, 201);
  const inviteCode = new URL(invite.data.url).pathname.split('/').at(-1);
  assert.ok(inviteCode);
  assert.equal((await api(`/invites/${inviteCode}/accept`, 'POST')).response.status, 200);
  assert.equal((await api(`/rooms/${room.data.id}/invites`, 'DELETE')).response.status, 200);
  assert.equal((await api(`/invites/${inviteCode}/accept`, 'POST')).response.status, 404);

  await api(`/agents/${firstAgent.data.id}`, 'PATCH', { daily_limit: 2 });
  const concurrent = await Promise.all(Array.from({ length: 5 }, (_, index) => tool(token, 'post_message', { room_id: room.data.id, body: `並行送信${index}` })));
  assert.equal(concurrent.filter((result) => !result.isError).length, 1);
  assert.equal(concurrent.filter((result) => result.isError).length, 4);

  const metadata = await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`);
  assert.equal((await metadata.json() as { resource: string }).resource, `${origin}/mcp`);
  const redirectUri = 'http://127.0.0.1:49199/callback';
  const registration = await fetch(`${origin}/oauth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Test MCP Client', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) });
  assert.equal(registration.status, 201);
  const client = await registration.json() as { client_id: string };
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const query = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: 'S256', resource: `${origin}/mcp`, scope: 'rooms offline_access', state: 'synthetic-state' });
  const consent = await fetch(`${origin}/authorize?${query}`, { headers: { Cookie: cookie }, redirect: 'manual' });
  assert.equal(consent.status, 200);
  assert.equal(consent.headers.get('referrer-policy'), 'same-origin');
  assert.match(consent.headers.get('content-security-policy') ?? '', /form-action 'self' http:\/\/127\.0\.0\.1:49199$/);
  assert.match(consent.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
  const ordinaryPage = await fetch(`${origin}/api/session`);
  assert.equal(ordinaryPage.headers.get('referrer-policy'), 'no-referrer');
  assert.match(ordinaryPage.headers.get('content-security-policy') ?? '', /form-action 'self'$/);
  const html = await consent.text();
  assert.match(html, /選んだエージェントとして、会話の閲覧、添付を含む投稿/);
  assert.match(html,/自分の画像・接続環境の画像/);
  assert.match(html,/自分が作ったルームの公開範囲、招待、参加者の管理、ルームの削除/);
  const handle = html.match(/name="handle" value="([^"]+)"/)?.[1];
  assert.ok(handle);
  const consentCookies = consent.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
  const consentBody = new URLSearchParams({ handle, agent_id: secondAgent.data.id, decision: 'approve', offline_access: 'yes' });
  const submitConsent = (originHeader?: string, bindingCookie = consentCookies) => fetch(`${origin}/authorize`, {
    method: 'POST', headers: { ...(originHeader === undefined ? {} : { Origin: originHeader }), Cookie: `${cookie}; ${bindingCookie}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: consentBody, redirect: 'manual',
  });
  assert.equal((await submitConsent()).status, 403);
  assert.equal((await submitConsent('null')).status, 403);
  assert.equal((await submitConsent('https://untrusted.invalid')).status, 403);
  assert.equal((await submitConsent(origin, '')).status, 400);
  const approve = await submitConsent(origin);
  assert.equal(approve.status, 302);
  assert.equal(approve.headers.get('referrer-policy'), 'no-referrer');
  const callback = new URL(approve.headers.get('location') ?? '');
  assert.equal(callback.searchParams.get('state'), 'synthetic-state');
  const code = callback.searchParams.get('code'); assert.ok(code);
  const tokenReply = await fetch(`${origin}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri, client_id: client.client_id, resource: `${origin}/mcp` }) });
  assert.equal(tokenReply.status, 200);
  const issuedOauth = await tokenReply.json() as { access_token: string; refresh_token: string };
  const oauthToken = issuedOauth.access_token;
  assert.ok(issuedOauth.refresh_token);
  const oauthPolicy = await tool(oauthToken, 'get_my_policy');
  assert.equal(JSON.parse(oauthPolicy.content[0].text).name, 'Dot test');
  assert.equal(Boolean((await tool(oauthToken, 'set_my_image', { kind: 'platform', ...imageBody })).isError), false);
  const oauthImage = await fetch(`${origin}/api/images/platform/${secondAgent.data.id}`, { headers: { Cookie: cookie } });
  assert.equal(Buffer.from(await oauthImage.arrayBuffer()).toString('base64'), imageData);
  const firstAfterOauth = await fetch(`${origin}/api/images/agent/${firstAgent.data.id}`, { headers: { Cookie: cookie } });
  assert.deepEqual(Buffer.from(await firstAfterOauth.arrayBuffer()), largePng);
  const oauthForbidden = await fetch(`${origin}/api/rooms`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${oauthToken}` }, body: JSON.stringify({ name: 'not allowed' }) });
  assert.equal(oauthForbidden.status, 403);

  const now = new Date();
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const clock = (value: number) => `${String(Math.floor(((value + 1440) % 1440) / 60)).padStart(2, '0')}:${String((value + 1440) % 60).padStart(2, '0')}`;
  assert.equal((await api(`/rooms/${room.data.id}/agents`, 'POST', { agent_id: secondAgent.data.id })).response.status, 201);
  const partialHistory = JSON.parse((await tool(oauthToken, 'read_messages', { room_id: room.data.id, limit: 1 })).content[0].text);
  assert.deepEqual(partialHistory.messages.map((message: { id: string }) => message.id), [humanMessage.data.id]);
  const partiallyRead = (await api(`/rooms/${room.data.id}/messages`)).data.messages;
  assert.deepEqual(new Set(partiallyRead[0].read_by.map((reader: { agent_id: string }) => reader.agent_id)), new Set([firstAgent.data.id, secondAgent.data.id]));
  assert.equal(partiallyRead[1].read_by.some((reader: { agent_id: string }) => reader.agent_id === secondAgent.data.id), false);
  const secondUnread = JSON.parse((await tool(oauthToken, 'get_unread', { room_id: room.data.id })).content[0].text);
  assert.equal(secondUnread.messages.some((item: { id: string }) => item.id === humanMessage.data.id), true);
  assert.equal(secondUnread.messages.find((item: { id: string }) => item.id === humanMessage.data.id).priority_mention, false);
  const afterSecondRead = (await api(`/rooms/${room.data.id}/messages`)).data.messages;
  assert.deepEqual(afterSecondRead[1].read_by.map((reader: { agent_id: string }) => reader.agent_id), [secondAgent.data.id]);

  // The maximum history page must fit D1's bound-parameter limit and mark all returned messages.
  const bulkRoom = await api('/rooms', 'POST', { name: 'Bulk history', visibility: 'invite' });
  assert.equal((await api(`/rooms/${bulkRoom.data.id}/agents`, 'POST', { agent_id: firstAgent.data.id })).response.status, 201);
  const bulkSql = `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 100)
    INSERT INTO messages (id, room_id, author_user_id, body, created_at)
    SELECT 'bulk-' || x, '${bulkRoom.data.id}', host_user_id, 'bulk ' || x, x FROM n, rooms WHERE rooms.id = '${bulkRoom.data.id}'`;
  const bulkSeed = spawnSync(wrangler, ['d1', 'execute', 'a2aroom-test', '--local', '--persist-to', fixture.state,
    '--config', fixture.configPath, '--command', bulkSql], { cwd: root, encoding: 'utf8', env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' } });
  assert.equal(bulkSeed.status, 0, bulkSeed.stderr);
  const search = async (before_seq?: number) => JSON.parse((await tool(token, 'search_messages', {room_id: bulkRoom.data.id, query:'bulk', limit:2, before_seq})).content[0].text);
  const page1 = await search();
  assert.deepEqual(page1.messages.map((m:{id:string}) => m.id), ['bulk-100','bulk-99']);
  assert.equal((await search(page1.next_before_seq)).messages[0].id, 'bulk-98');
  assert.deepEqual((await api(`/rooms/${bulkRoom.data.id}/messages`)).data.messages.at(-1).read_by, []);
  assert.equal((await tool(oauthToken,'search_messages',{room_id:bulkRoom.data.id,query:'bulk'})).isError,true);
  const bulkHistory = JSON.parse((await tool(token, 'read_messages', { room_id: bulkRoom.data.id, limit: 100 })).content[0].text);
  assert.equal(bulkHistory.messages.length, 100);
  const bulkDisplayed = (await api(`/rooms/${bulkRoom.data.id}/messages`)).data.messages;
  assert.equal(bulkDisplayed.length, 50);
  assert.equal(bulkDisplayed.every((message: { read_by: Array<{ agent_id: string }> }) => message.read_by.some((reader) => reader.agent_id === firstAgent.data.id)), true);
  assert.equal((await api(`/agents/${secondAgent.data.id}`, 'PATCH', { timezone: 'UTC', quiet_start: clock(minutes - 1), quiet_end: clock(minutes + 2) })).response.status, 200);
  assert.equal((await tool(oauthToken, 'post_message', { room_id: room.data.id, body: '静かな時間の投稿' })).isError, true);
  assert.equal((await api(`/agents/${secondAgent.data.id}`, 'PATCH', { quiet_start: null, quiet_end: null })).response.status, 200);
  const warning = await tool(oauthToken, 'post_message', { room_id: room.data.id, body: '住所は〒123-4567です', reply_to: humanMessage.data.id });
  assert.deepEqual(JSON.parse(warning.content[0].text).warnings, ['address']);
  assert.equal((await api('/notifications')).data.notifications.some((item: { kind: string }) => item.kind === 'privacy_warning'), true);

  assert.equal((await api('/notification-settings', 'PUT', { mention_enabled: true })).response.status, 200);
  assert.equal((await fetch(`${origin}/__scheduled`)).status, 200);
  const notices = (await api('/notifications')).data.notifications;
  assert.equal(notices.some((notice: { kind: string }) => notice.kind === 'digest'), false);
  const replyNotice = notices.find((notice: { kind: string }) => notice.kind === 'reply');
  assert.equal(replyNotice.source_message_id, JSON.parse(warning.content[0].text).id);
  assert.ok(replyNotice.source_seq > 0);
  assert.equal(replyNotice.body, '住所は〒123-4567です');
  const editTarget = {room_id:room.data.id,message_id:JSON.parse(warning.content[0].text).id};
  const budget = async () => JSON.parse((await tool(oauthToken,'get_my_policy',{})).content[0].text);
  assert.equal((await api(`/agents/${secondAgent.data.id}`, 'PATCH', { mode: 'all', private_categories: ['address', 'contact', '旅行先'] })).response.status, 200);
  const quota = await budget();
  assert.equal(quota.mode, 'all');
  assert.equal(quota.timezone, 'UTC');
  assert.deepEqual(quota.private_categories, ['address', 'contact', '旅行先']);
  assert.equal(quota.posts_used_today, 1);
  assert.equal(quota.posts_remaining_today, quota.daily_limit - 1);
  assert.ok(Date.parse(quota.resets_at) > Date.now());
  for (const name of ['edit_message','delete_message']) {
    const args = name === 'edit_message' ? {...editTarget,body:'invalid edit'} : editTarget;
    assert.equal((await tool(token, name, args)).isError,true);
    assert.equal((await tool(oauthToken, name, {...args,message_id:humanMessage.data.id})).isError,true);
  }
  const editedReply = '訂正 〒123-4567' + '🎉'.repeat(85);
  const edit = await tool(oauthToken,'edit_message',{...editTarget,body:editedReply});
  assert.deepEqual(JSON.parse(edit.content[0].text).warnings,['address']);
  assert.equal((await api(`/rooms/${room.data.id}/messages`)).data.messages.find((m:{id:string})=>m.id===editTarget.message_id).body,editedReply);
  const replyNotices = async () => (await api('/notifications')).data.notifications.filter((n: {kind: string; source_message_id: string}) => n.kind === 'reply' && n.source_message_id === editTarget.message_id);
  assert.equal((await replyNotices())[0].body, [...editedReply].slice(0,80).join('') + '…');
  assert.equal(Boolean((await tool(oauthToken,'delete_message',editTarget)).isError),false);
  assert.deepEqual(await replyNotices(), []);
  const gone = await tool(oauthToken,'search_messages',{room_id:room.data.id,query:'訂正'});
  assert.deepEqual(JSON.parse(gone.content[0].text).messages,[]);
  assert.equal((await budget()).posts_remaining_today,quota.posts_remaining_today);
  const afterOauth = await api('/agents');
  const oauthConnection = afterOauth.data.connections.find((item: { kind: string; agent_id: string }) => item.kind === 'oauth' && item.agent_id === secondAgent.data.id);
  assert.ok(oauthConnection);
  assert.equal((await api(`/connections/${oauthConnection.id}`, 'DELETE')).response.status, 200);
  assert.equal((await rpc(oauthToken, 'tools/list')).response.status, 401);
  assert.equal((await rpc(oauthToken, 'tools/call', { name: 'set_my_image', arguments: { kind: 'agent', ...imageBody } })).response.status, 401);
  const revokedRefresh = await fetch(`${origin}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: issuedOauth.refresh_token, client_id: client.client_id, resource: `${origin}/mcp` }) });
  assert.equal(revokedRefresh.status, 400);
  assert.equal((await api(`/connections/${tokenResponse.data.id}`, 'DELETE')).response.status, 200);
  assert.equal((await rpc(token, 'tools/list')).response.status, 401);
  assert.equal((await rpc(token, 'tools/call', { name: 'remove_my_image', arguments: { kind: 'agent' } })).response.status, 401);

  // Image changes are available before joining a room and cannot bypass the per-agent limit with concurrent calls.
  const rateAgent = await api('/agents', 'POST', { name: 'Image rate fixture', handle: 'image-rate', platform: 'Test' });
  const rateConnection = await api(`/agents/${rateAgent.data.id}/connections`, 'POST', { label: 'image-rate-test' });
  const imageCalls = await Promise.all(Array.from({ length: 35 }, () => tool(rateConnection.data.token, 'remove_my_image', { kind: 'agent' })));
  assert.equal(imageCalls.filter((result) => !result.isError).length, 30);
  assert.equal(imageCalls.filter((result) => result.isError && JSON.parse(result.content[0].text).error === 'IMAGE_RATE_LIMIT').length, 5);
  await api(`/rooms/${room.data.id}/agents`, 'POST', {agent_id:rateAgent.data.id});
  assert.equal((await api(`/agents/${rateAgent.data.id}`, 'DELETE')).response.status, 200);
  assert.equal((await rpc(rateConnection.data.token, 'tools/list')).response.status, 401);
  const remaining = (await api('/agents')).data;
  assert.ok(!remaining.agents.some((a:{id:string}) => a.id === rateAgent.data.id));
  assert.ok(!remaining.connections.some((a:{agent_id:string}) => a.agent_id === rateAgent.data.id));
  assert.ok(!(await api(`/rooms/${room.data.id}`)).data.members.some((m:{agent_id:string}) => m.agent_id === rateAgent.data.id));

  const historyRoom = await api('/rooms', 'POST', { name: 'History fixture', visibility: 'invite' });
  for (let i = 0; i < 55; i++) assert.equal((await api(`/rooms/${historyRoom.data.id}/messages`, 'POST', { body: `履歴テスト ${i}` })).response.status, 201);
  const latest = await api(`/rooms/${historyRoom.data.id}/messages`);
  assert.equal(latest.data.messages.length, 50);
  assert.equal(latest.data.has_more, true);
  const older = await api(`/rooms/${historyRoom.data.id}/messages?before=${latest.data.messages[0].id}`);
  assert.equal(older.data.messages.length, 5);
  assert.equal(older.data.has_more, false);
  assert.ok(older.data.messages.at(-1).seq < latest.data.messages[0].seq);
  assert.equal((await api(`/rooms/${historyRoom.data.id}`, 'DELETE')).response.status, 200);
  assert.equal((await api(`/rooms/${historyRoom.data.id}/messages`)).response.status, 404);
});

test('development public modes isolate anonymous visitors and preserve private rooms', { timeout: 120_000 }, async (t) => {
  const fixture = await startFixture({ publicAccess: true });
  t.after(async () => {
    fixture.child.kill('SIGTERM');
    await new Promise<void>((resolve) => { if (fixture.child.exitCode !== null) resolve(); else fixture.child.once('exit', () => resolve()); });
    await rm(fixture.directory, { recursive: true, force: true });
  });
  const { origin } = fixture;
  const client = (account?:string) => {
    let {cookie,csrf} = account ? seedSession(fixture,account) : {cookie:'',csrf:''};
    return async (url: string, method = 'GET', body?: unknown, extra: Record<string, string> = {}) => {
      const response = await fetch(`${origin}/api${url}`, { method, headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
      const data = await response.json() as Record<string, any>;
      const setCookie = response.headers.get('set-cookie'); if (setCookie) cookie = setCookie.split(';')[0];
      if (typeof data.csrf === 'string') csrf = data.csrf;
      return { response, data, cookie, csrf };
    };
  };
  const owner = client('examplehost'); const member = client('satou'); const guest = client();
  const invite = await owner('/rooms', 'POST', { name: 'Invite only', access_mode: 'invite', tags:['秘密'], directory_listed:true });
  const registered = await owner('/rooms', 'POST', { name: 'Members', access_mode: 'registered', tags:['＃ＡＩ','ai','音楽'] });
  const anonymous = await owner('/rooms', 'POST', { name: 'Open room', access_mode: 'anonymous' });
  assert.equal(invite.response.status, 201); assert.equal(registered.response.status, 201); assert.equal(anonymous.response.status, 201);
  const ownerId = (await owner('/session')).data.user.id as string;
  const agent = await owner('/agents', 'POST', { name: 'Muse', handle: 'muse', platform: 'Muse' });
  assert.equal((await owner(`/rooms/${anonymous.data.id}/agents`, 'POST', { agent_id: agent.data.id })).response.status, 201);
  const image = { mime: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' };
  assert.equal((await owner(`/images/user/${ownerId}`, 'PUT', image)).response.status, 200);
  assert.equal((await owner(`/images/agent/${agent.data.id}`, 'PUT', image)).response.status, 200);
  assert.equal((await member(`/images/user/${ownerId}`)).response.status, 404);
  const directory = (await guest('/public/rooms')).data.rooms;
  assert.deepEqual(directory.map((room: { id: string }) => room.id), [anonymous.data.id]);
  assert.equal((await guest(`/public/rooms/${invite.data.id}`)).response.status, 404);
  assert.equal((await guest(`/public/rooms/${registered.data.id}`)).response.status, 200);
  assert.equal((await guest(`/public/rooms/${invite.data.id}/messages`)).response.status, 404);
  assert.equal((await guest(`/public/rooms/${registered.data.id}/session`, 'POST')).response.status, 404);
  const previewPath = '/public/rooms/' + registered.data.id;
  assert.equal((await guest(previewPath+'/session')).data.active, false);
  assert.equal((await guest(previewPath+'/messages?view=timeline')).response.status, 200);
  assert.equal((await member(previewPath+'/messages?view=timeline')).response.status, 200);
  assert.equal((await member('/rooms')).data.rooms.length, 0);
  await owner('/rooms/'+registered.data.id+'/access','PATCH',{access_mode:'registered',directory_listed:false});
  assert.equal((await guest(previewPath+'/messages')).response.status,404);
  await owner('/rooms/'+registered.data.id+'/access','PATCH',{access_mode:'registered',directory_listed:true});
  const popularTags = async () => (await member('/directory/popular-tags')).data.tags;
  assert.deepEqual(await popularTags(), ['AI', '音楽']);
  await owner(`/rooms/${anonymous.data.id}/tags`, 'PATCH', { operation: 'add', tags: ['音楽','Game'] });
  assert.deepEqual(await popularTags(), ['音楽','AI','Game']);
  await owner(`/rooms/${anonymous.data.id}/tags`, 'PATCH', { operation: 'remove', tags: ['音楽','Game'] });
  const browse = async (params='') => (await guest('/explore/rooms'+params)).data;
  assert.deepEqual(new Set((await browse()).rooms.map((r:{id:string})=>r.id)), new Set([registered.data.id,anonymous.data.id]));
  assert.deepEqual((await browse('?tag=%EF%BC%A1i&mode=registered')).rooms[0].tags, ['AI','音楽']);
  assert.equal((await browse('?tag='+encodeURIComponent('秘密'))).rooms.length,0);
  assert.equal((await guest('/explore/rooms?sort=no-such-sort')).response.status,400);
  assert.equal((await owner('/rooms','POST',{name:'invalid tags',tags:['1','2','3','4','5','6']})).response.status,400);
  assert.equal((await browse('?sort=members')).rooms[0].agent_count,1);
  assert.equal((await browse('?mode=registered')).rooms[0].participants,null);
  assert.equal((await member('/directory/rooms?mode=registered')).data.rooms[0].participants,null);
  assert.equal((await browse('?mode=anonymous')).rooms[0].participants.some((p:{name:string})=>p.name==='Muse'),true);
  assert.equal((await guest('/admin/inquiries')).response.status,401);
  assert.equal((await member('/admin/inquiries')).response.status,403);
  const form={method:'POST',headers:{Origin:origin},redirect:'manual' as const,
    body:new URLSearchParams({category:'privacy',email:'contact@example.test',body:'保有データについての合成確認'})};
  assert.equal((await fetch(origin+'/contact',form)).status,303);
  const inquiry=(await owner('/admin/inquiries')).data.inquiries[0];
  assert.equal(inquiry.email,'contact@example.test');
  assert.equal((await member('/admin/inquiries/'+inquiry.id+'/resolve','POST')).response.status,403);
  assert.equal((await owner('/admin/inquiries/'+inquiry.id+'/resolve','POST')).response.status,200);
  assert.equal((await owner('/admin/inquiries')).data.inquiries.length,0);
  const memberDirectory = (await member('/directory/rooms')).data.rooms;
  assert.deepEqual(new Set(memberDirectory.map((room: { id: string }) => room.id)), new Set([registered.data.id, anonymous.data.id]));
  assert.equal((await member(`/rooms/${registered.data.id}`)).response.status, 403);
  assert.equal((await member(`/rooms/${invite.data.id}/join`, 'POST')).response.status, 403);
  assert.equal((await member(`/rooms/${registered.data.id}/join`, 'POST')).response.status, 200);
  assert.equal((await member(`/rooms/${registered.data.id}`)).response.status, 200);
  const renamePath = `/rooms/${registered.data.id}/name`;
  assert.equal((await member(renamePath, 'PATCH', { name: 'Unauthorized' })).response.status, 403);
  for (const name of ['   ', 'x'.repeat(81)]) {
    assert.equal((await owner(renamePath, 'PATCH', { name })).response.status, 400);
  }
  assert.equal((await owner(renamePath, 'PATCH', { name: '  New name  ' })).data.name, 'New name');
  assert.equal((await member(`/rooms/${registered.data.id}`)).data.room.name, 'New name');
  assert.equal((await browse('?mode=registered')).rooms[0].name, 'New name');
  const descriptionPath = `/rooms/${registered.data.id}/description`;
  assert.equal((await member(descriptionPath, 'PATCH', { description: 'Unauthorized' })).response.status, 403);
  const description = 'x'.repeat(500);
  assert.equal((await owner(descriptionPath, 'PATCH', { description })).data.description, description);
  for (const invalid of [{}, { description: null }, { description: description + 'x' }]) {
    assert.equal((await owner(descriptionPath, 'PATCH', invalid)).response.status, 400);
  }
  assert.equal((await member(`/rooms/${registered.data.id}`)).data.room.description, description);
  assert.equal((await browse('?mode=registered')).rooms[0].description, description);
  assert.equal((await owner(descriptionPath, 'PATCH', { description: '' })).data.description, '');
  assert.equal((await browse('?mode=registered')).rooms[0].description, '');
  const imageVersions = (await owner('/images')).data.images as {kind: string; subject_id: string; updated_at: number}[];
  const ownerVersion = imageVersions.find(image => image.kind === 'user' && image.subject_id === ownerId)!.updated_at;
  const agentVersion = imageVersions.find(image => image.kind === 'agent' && image.subject_id === agent.data.id)!.updated_at;
  const memberInbox = (await member('/rooms')).data.rooms;
  assert.deepEqual(memberInbox.map((room: { id: string }) => room.id), [registered.data.id]);
  assert.deepEqual(memberInbox[0].portraits.map((person: { name: string }) => person.name), ['examplehost', 'satou']);
  const ownerInbox = (await owner('/rooms')).data.rooms;
  const listedCounts = ownerInbox.find((room: {id:string}) => room.id === anonymous.data.id);
  assert.equal(listedCounts.message_count, 0);
  assert.equal(listedCounts.human_count, 1);
  assert.equal(listedCounts.agent_count, 1);
  assert.equal(memberInbox[0].human_count, 2);
  assert.equal(memberInbox[0].agent_count, 0);
  assert.deepEqual(ownerInbox.find((room: { id: string }) => room.id === anonymous.data.id).portraits, [
    { kind: 'agent', id: agent.data.id, name: 'Muse', image_version: agentVersion }, { kind: 'human', id: ownerId, name: 'examplehost', image_version: ownerVersion },
  ]);
  assert.equal((await member('/images')).data.images.some((item: { kind: string; subject_id: string }) => item.kind === 'user' && item.subject_id === ownerId), true);
  assert.equal((await member(`/images/agent/${agent.data.id}`)).response.status, 404);
  assert.equal((await member(`/rooms/${registered.data.id}/access`, 'PATCH', { access_mode: 'anonymous' })).response.status, 403);
  const tagPath = '/rooms/' + invite.data.id + '/tags';
  const changeTags = (operation: string, tags: string[]) => owner(tagPath, 'PATCH', { operation, tags });
  assert.equal((await member('/rooms/' + registered.data.id + '/tags', 'PATCH', { operation: 'remove', tags: ['AI'] })).response.status, 403);
  const concurrentAdds = await Promise.all([changeTags('add', ['ＡＩ', '旅行']), changeTags('add', ['映画', '音楽'])]);
  assert.ok(concurrentAdds.every(result => result.response.ok));
  const currentTags = async () => (await owner('/rooms/' + invite.data.id)).data.room.tags as string[];
  assert.deepEqual(new Set(await currentTags()), new Set(['秘密', 'AI', '旅行', '映画', '音楽']));
  assert.equal((await changeTags('add', ['ai'])).response.status, 200);
  assert.equal((await changeTags('add', ['料理'])).response.status, 409);
  assert.ok(!(await currentTags()).includes('料理'));
  await changeTags('remove', ['秘密', 'ＡＩ']);
  await changeTags('remove', ['秘密']);
  const afterTags = (await owner('/rooms/' + invite.data.id)).data.room;
  assert.deepEqual(new Set(afterTags.tags), new Set(['旅行', '映画', '音楽']));
  assert.equal(afterTags.access_mode, 'invite');
  assert.equal(afterTags.directory_listed, 0);
  const sharedRoom = '/rooms/' + registered.data.id;
  const ownerProfile = sharedRoom + '/profiles/human/' + ownerId;
  const who = (await owner('/session')).data.user;
  assert.equal((await owner('/account/profile','PATCH',{display_name:'   '})).response.status,400);
  assert.equal((await owner('/account/profile','PATCH',{display_name:'  たかとし  '})).response.status,200);
  assert.equal((await owner('/session')).data.user.display_name,'たかとし');
  const socialPath = '/account/profile/social-links';
  assert.deepEqual((await owner(socialPath)).data,{});
  const links = {instagram:'https://www.instagram.com/alice/',threads:'https://www.threads.com/@alice',tiktok:'https://www.tiktok.com/@alice',x:'https://x.com/alice',bereal:'https://bere.al/alice',setlog:'https://setlog.kr/invite/abc'};
  assert.deepEqual((await owner(socialPath,'PUT',links)).data,links);
  assert.equal((await owner(socialPath,'PUT',{x:'https://example.org/alice'})).response.status,400);
  assert.deepEqual((await owner(socialPath)).data,links);
  assert.deepEqual((await member(socialPath)).data,{});
  assert.deepEqual((await owner(socialPath,'PUT',{})).data,{});
  assert.equal((await owner('/account/profile/bio','PUT',{bio:'a'.repeat(301)})).response.status,400);
  assert.equal((await owner('/account/profile/bio','PUT',{bio:'こんにちは'})).response.status,200);
  assert.equal((await owner('/session')).data.user.bio,'こんにちは');
  const human = (await guest('/public/rooms/'+anonymous.data.id+'/profiles/human/'+who.id)).data;
  assert.equal(human.bio,'こんにちは');
  assert.equal((await owner('/account/profile/bio','PUT',{bio:''})).response.status,200);
  assert.equal((await owner('/session')).data.user.bio,null);
  assert.equal(human.name,'たかとし');
  assert.equal(human.account_name,who.account_name);
  assert.equal((await member('/session')).data.user.display_name,null);
  await owner('/account/profile','PATCH',{display_name:who.account_name});
  const agentProfile = '/rooms/' + anonymous.data.id + '/profiles/agent/' + agent.data.id;
  const profile = (await member(ownerProfile)).data;
  assert.equal(profile.name, 'examplehost');
  assert.ok(!('email' in profile));
  assert.equal((await member('/rooms/' + invite.data.id + '/profiles/human/' + ownerId)).response.status, 404);
  assert.equal((await member(agentProfile)).response.status, 404);
  assert.equal((await owner(agentProfile)).data.can_rename, 1);
  assert.equal((await owner('/agents/' + agent.data.id, 'PATCH', { name: 'Renamed Muse', profile_text: '共有の紹介' })).response.status, 200);
  const guestProfile = (await guest('/public' + agentProfile)).data;
  assert.equal(guestProfile.name, 'Renamed Muse');
  assert.equal(guestProfile.handle, 'muse');
  assert.equal(guestProfile.bio, '共有の紹介');
  assert.equal(guestProfile.can_rename, 0);
  assert.ok(!('private_categories' in guestProfile) && !('tone_note' in guestProfile));
  const post = (await owner(sharedRoom + '/messages', 'POST', { body: '既読の検証' })).data;
  assert.equal((await member('/inbox/latest')).data.message.id, post.id);
  await owner('/rooms/' + invite.data.id + '/messages', 'POST', { body: '別室のお知らせ' });
  assert.equal((await member('/inbox/latest')).data.message.id, post.id);
  const receipt = { messages: [{ id: post.id, edited_at: null }] };
  const readCount = async () => (await owner(sharedRoom + '/messages')).data.messages[0].read_count;
  assert.equal((await member(sharedRoom + '/read', 'POST', { message_id: post.id })).response.status, 200);
  await owner(sharedRoom + '/read-receipts', 'POST', receipt);
  assert.equal(await readCount(), 0);
  assert.equal((await member(sharedRoom + '/read-receipts', 'POST', receipt)).response.status, 200);
  await member(sharedRoom + '/read-receipts', 'POST', receipt);
  assert.equal(await readCount(), 1);
  assert.equal((await owner('/messages/' + post.id, 'PATCH', { body: '編集後' })).response.status, 200);
  await member(sharedRoom + '/read-receipts', 'POST', receipt);
  assert.equal(await readCount(), 0);
  receipt.messages[0].edited_at = (await member(sharedRoom + '/messages')).data.messages[0].edited_at;
  await member(sharedRoom + '/read-receipts', 'POST', receipt);
  assert.equal(await readCount(), 1);
  assert.equal((await member('/blocks', 'POST', { account_name: 'examplehost' })).response.status, 201);
  assert.equal(await readCount(), 0);
  assert.equal((await member('/rooms')).data.rooms[0].message_count, 0);
  assert.equal((await member('/inbox/latest')).data.message, null);
  assert.equal((await member(ownerProfile)).response.status, 404);
  assert.deepEqual((await member('/rooms')).data.rooms[0].portraits.map((person: { name: string }) => person.name), ['satou']);
  assert.deepEqual((await owner('/rooms')).data.rooms.find((room: { id: string }) => room.id === registered.data.id).portraits, [
    { kind: 'human', id: ownerId, name: 'examplehost', image_version: ownerVersion },
  ]);
  assert.equal((await member(`/images/user/${ownerId}`)).response.status, 404);
  assert.equal((await member(`/directory/rooms/${anonymous.data.id}`)).response.status, 404);
  assert.equal((await member(`/rooms/${anonymous.data.id}/join`, 'POST')).response.status, 403);
  assert.equal((await member(`/blocks/${ownerId}`, 'DELETE')).response.status, 200);
  const publicImages = (await guest(`/public/rooms/${anonymous.data.id}/images`)).data.images;
  assert.equal(publicImages.some((item: { kind: string; subject_id: string }) => item.kind === 'agent' && item.subject_id === agent.data.id), true);
  assert.equal((await fetch(`${origin}/api/public/rooms/${anonymous.data.id}/images/agent/${agent.data.id}`)).status, 200);
  assert.equal((await guest(`/public/rooms/${invite.data.id}/images`)).response.status, 404);

  assert.equal((await guest(`/public/rooms/${anonymous.data.id}/session`, 'POST',{display_name:'  '})).response.status,400);
  const joined = await guest(`/public/rooms/${anonymous.data.id}/session`, 'POST',{display_name:'  そら  ',image});
  assert.equal(joined.data.display_name,'そら');
  assert.equal(joined.response.status, 201);
  assert.match(joined.response.headers.get('set-cookie') ?? '', /HttpOnly; Secure; SameSite=Strict/);
  assert.equal((await guest('/rooms')).response.status, 401);
  assert.equal((await guest(`/images/agent/${agent.data.id}`, 'PUT', image)).response.status, 401);
  assert.equal((await guest(`/public/rooms/${anonymous.data.id}/messages`, 'POST', { body: '無効な送信' }, { 'X-CSRF-Token': 'wrong' })).response.status, 403);
  assert.equal((await guest(`/public/rooms/${anonymous.data.id}/messages`, 'POST', { body: '無効な送信' }, { Origin: 'https://untrusted.invalid' })).response.status, 403);
  const guestRoomPath = '/public/rooms/' + anonymous.data.id;
  const guestPhotoPath = guestRoomPath + '/session/image';
  const guestPhotoUrl = origin + '/api' + guestRoomPath + '/images/user/' + joined.data.user_id;
  assert.equal((await fetch(guestPhotoUrl)).status,200);
  assert.equal((await client()(guestPhotoPath,'PUT',image)).response.status,401);
  assert.equal((await guest(guestPhotoPath,'PUT',image,{'X-CSRF-Token':'wrong'})).response.status,403);
  assert.equal((await guest(guestPhotoPath,'PUT',{mime:'image/png',data:'broken'})).response.status,400);
  assert.ok((await guest(guestPhotoPath,'PUT',image)).data.updated_at > joined.data.image_version);
  const publicEvent = (await guest(guestRoomPath + '/messages?view=timeline')).data.items[0];
  assert.equal(publicEvent.account_name, 'examplehost');
  assert.equal(publicEvent.member_agent_id, agent.data.id);
  assert.equal((await guest(guestRoomPath + '/profiles/agent/' + publicEvent.member_agent_id)).data.handle, 'muse');
  const guestOwnProfile = (await guest(guestRoomPath + '/profiles/human/' + joined.data.user_id)).data;
  assert.equal(guestOwnProfile.account_name, '匿名');
  assert.equal(guestOwnProfile.is_guest, 1);
  assert.equal(guestOwnProfile.name,'そら');
  const guestPost = await guest(`/public/rooms/${anonymous.data.id}/messages`, 'POST', { body: '匿名の発言です' });
  assert.equal(guestPost.response.status, 201);
  const latestListing=(await browse('?mode=anonymous')).rooms[0];
  assert.deepEqual(latestListing.participants.find((p:{name:string})=>p.name==='そら'),{kind:'human',name:'そら'});
  assert.equal(latestListing.message_count,1);
  assert.equal(latestListing.human_count,2); assert.equal(latestListing.active_count,1);
  assert.equal(JSON.stringify(latestListing).includes('匿名の発言です'),false);
  const guestMessages = (await guest(`/public/rooms/${anonymous.data.id}/messages`)).data.messages;
  assert.equal(guestMessages[0].account_name, '匿名');
  assert.equal(guestMessages[0].display_name,'そら');
  assert.equal(guestMessages[0].body, '匿名の発言です');
  assert.equal((await owner(`/rooms/${anonymous.data.id}/messages`)).data.messages[0].account_name, '匿名');
  const connection = await owner(`/agents/${agent.data.id}/connections`, 'POST', { label: 'anonymous-test' });
  const mcp = async (name: string, args: Record<string, unknown>) => {
    const response = await fetch(`${origin}/mcp`, { method: 'POST', headers: { ...callHeaders, Authorization: `Bearer ${connection.data.token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    assert.equal(response.status, 200);
    const data = await response.json() as Record<string, any>;
    return JSON.parse(data.result.content[0].text);
  };
  const history = await mcp('read_messages', { room_id: anonymous.data.id });
  assert.equal(history.messages[0].account_name, 'Anonymous');
  assert.equal(history.messages[0].is_guest, 1);
  assert.equal((await mcp('get_room_members', { room_id: anonymous.data.id })).members.some((item: { account_name: string }) => item.account_name === 'Anonymous'), true);
  assert.equal((await guest(`/public/rooms/${anonymous.data.id}/reports`, 'POST', { message_id: guestPost.data.id, reason: 'テスト' })).response.status, 201);
  assert.equal((await owner('/admin/reports')).data.reports[0].reporter, '匿名');
  assert.equal((await owner('/inbox/latest')).data.message.sender, 'そら');
  assert.equal((await guest(guestRoomPath + '/inbox/latest')).data.message, null);
  const answer = await owner('/rooms/' + anonymous.data.id + '/messages', 'POST', { body: '匿名参加者への返信' });
  assert.equal((await guest(guestRoomPath + '/inbox/latest')).data.message.id, answer.data.id);
  assert.equal((await guest('/public/rooms/' + invite.data.id + '/inbox/latest')).response.status, 401);
  await guest('/public/rooms/'+anonymous.data.id+'/reports','POST',{message_id:answer.data.id,reason:'非表示を確認'});
  const report = (await owner('/admin/reports')).data.reports.find((r:{reason:string}) => r.reason==='非表示を確認');
  const hide = '/admin/reports/'+report.id+'/hide';
  assert.equal((await member(hide,'POST')).response.status,403);
  assert.equal((await owner(hide,'POST')).response.status,200);
  assert.equal((await owner(hide,'POST')).response.status,200);
  assert.equal((await guest(guestRoomPath+'/inbox/latest')).data.message,null);
  assert.equal((await mcp('read_messages',{room_id:anonymous.data.id})).messages.some((m:{id:string})=>m.id===answer.data.id),false);
  assert.equal((await browse('?mode=anonymous')).rooms[0].message_count,1);
  const profilePath = guestRoomPath + '/session/profile';
  const rename = {display_name:'  なつ  '};
  assert.equal((await client()(profilePath,'PATCH',rename)).response.status,401);
  assert.equal((await guest(profilePath,'PATCH',rename,{'X-CSRF-Token':'wrong'})).response.status,403);
  assert.equal((await guest('/public/rooms/'+invite.data.id+'/session/profile','PATCH',rename)).response.status,401);
  assert.equal((await guest(profilePath,'PATCH',{display_name:' '})).response.status,400);
  assert.equal((await guest(profilePath,'PATCH',{...rename,image:{}})).response.status,400);
  assert.equal((await guest(guestRoomPath+'/session')).data.display_name,'そら');
  assert.equal((await guest(profilePath,'PATCH',rename)).data.display_name,'なつ');
  assert.equal((await guest(guestRoomPath+'/session')).data.display_name,'なつ');
  assert.equal((await guest(guestRoomPath+'/messages')).data.messages[0].display_name,'なつ');
  assert.equal((await fetch(guestPhotoUrl)).status,200);
  assert.equal((await guest(guestRoomPath + '/session/end', 'POST')).response.status, 200);
  assert.equal((await guest(guestPhotoPath,'PUT',image)).response.status,401);
  assert.equal((await guest(profilePath,'PATCH',rename)).response.status,401);
  assert.equal((await guest(guestRoomPath + '/inbox/latest')).response.status, 401);
  assert.equal((await guest(`/public/rooms/${anonymous.data.id}/messages`, 'POST', { body: '退室後' })).response.status, 401);
  assert.equal((await guest(`/public/rooms/${anonymous.data.id}/session`, 'POST')).response.status, 201);
  assert.equal((await owner(`/rooms/${anonymous.data.id}/access`, 'PATCH', { access_mode: 'registered' })).response.status, 200);
  assert.equal((await guest(`/public/rooms/${anonymous.data.id}/messages`)).response.status, 200);
  assert.equal((await guest(`/public/rooms/${anonymous.data.id}/messages`, 'POST', { body: '非公開変更後' })).response.status, 404);
  assert.equal((await owner(`/rooms/${anonymous.data.id}/messages`)).data.messages[0].body, '匿名の発言です');
  assert.equal((await owner(`/rooms/${anonymous.data.id}`)).data.members.some((item: { account_name: string }) => item.account_name === '匿名'), false);
  assert.equal((await mcp('get_room_members', { room_id: anonymous.data.id })).members.some((item: { account_name: string }) => item.account_name === 'Anonymous'), false);
  assert.equal((await owner(`/rooms/${anonymous.data.id}/access`, 'PATCH', { access_mode: 'anonymous' })).response.status, 200);
  assert.equal((await guest(`/public/rooms/${anonymous.data.id}/session`)).data.active, false);
  assert.equal((await guest(`/public/rooms/${anonymous.data.id}/messages`, 'POST', { body: '再公開後' })).response.status, 401);

  // The same user's replies share a room-level acknowledgement. Other notices stay independent.
  const otherRoom = (await owner('/rooms', 'POST', { name: 'Other replies', access_mode: 'registered' })).data.id;
  await member('/rooms/' + otherRoom + '/join', 'POST');
  async function postAs(who: typeof member, room: string, body: string, parent?: string) {
    const res = await who('/rooms/' + room + '/messages', 'POST', { body, reply_to: parent });
    assert.equal(res.response.status, 201);
    return res.data.id as string;
  }
  const roomId = registered.data.id;
  const firstReply = await postAs(member, roomId, '最初の一文です。' + '長い続き'.repeat(30), post.id);
  const secondReply = await postAs(member, roomId, '二つ目の返信', post.id);
  const elsewhere = await postAs(member, otherRoom, '別室の返信', await postAs(owner, otherRoom, '別室の親'));
  const toMember = await postAs(owner, roomId, '参加者への返信', firstReply);
  const mention = await postAs(member, roomId, '@examplehost メンション');
  async function notice(who: typeof member, source: string) {
    const rows = (await who('/notifications')).data.notifications;
    const row = rows.find((n: { source_message_id: string }) => n.source_message_id === source);
    assert.ok(row);
    return row as { id: string; read_at: number | null; body: string };
  }
  const first = await notice(owner, firstReply);
  assert.equal(first.body, '最初の一文です。');
  await member('/notifications/' + first.id + '/read', 'POST');
  assert.equal((await notice(owner, firstReply)).read_at, null);
  assert.equal((await notice(member, toMember)).read_at, null);
  await owner('/notifications/' + first.id + '/read', 'POST');
  const readAt = (await notice(owner, firstReply)).read_at;
  assert.ok(readAt);
  assert.equal((await notice(owner, secondReply)).read_at, readAt);
  assert.equal((await notice(owner, elsewhere)).read_at, null);
  assert.equal((await notice(owner, mention)).read_at, null);
  assert.equal((await notice(member, toMember)).read_at, null);
  const later = await postAs(member, roomId, '後から届いた返信', post.id);
  const sibling = await postAs(member, roomId, 'さらに届いた返信', post.id);
  async function see(id: string, edited_at: number | null = null) {
    return (await owner(sharedRoom + '/read-receipts', 'POST', { messages: [{ id, edited_at }] })).data.replies_read;
  }
  assert.equal(await see(firstReply), false);
  assert.equal(await see(later, 1), false);
  assert.equal((await notice(owner, later)).read_at, null);
  assert.equal(await see(later), true);
  assert.ok((await notice(owner, sibling)).read_at);
  assert.equal((await notice(owner, firstReply)).read_at, readAt);
  assert.equal((await notice(owner, mention)).read_at, null);
  await t.test('agent membership events stay ordered, paginated and visible only to the room audience', async () => {
    const registeredRoom = (await owner('/rooms', 'POST', { name: '会話履歴', access_mode: 'registered' })).data.id;
    const path = '/rooms/' + registeredRoom;
    const timeline = path + '/messages?view=timeline';
    assert.equal((await member(timeline)).response.status, 403);
    assert.equal((await guest('/public' + timeline)).response.status, 200);
    await member(path + '/join', 'POST');
    const agentId = (await member('/agents', 'POST', { name: '参加テスト', handle: 'room-agent', platform: 'Muse' })).data.id;
    assert.equal((await owner('/agents/' + agentId, 'DELETE')).response.status, 404);
    const join = () => member(path + '/agents', 'POST', { agent_id: agentId });
    const leave = () => member(path + '/agents/' + agentId, 'DELETE');
    assert.equal((await join()).response.status, 201);
    assert.equal((await join()).response.status, 409);
    assert.equal((await owner(timeline)).data.items[0].member_agent_id, agentId);
    const text = await postAs(owner, registeredRoom, '会話の途中');
    await member('/agents/' + agentId, 'PATCH', { name: '変更後' });
    const joined = (await owner(path)).data.members.find((m: { agent_id: string }) => m.agent_id === agentId);
    assert.equal((await owner(path + '/members/' + joined.id, 'DELETE')).response.status, 200);
    assert.equal((await leave()).response.status, 404);
    const original = (await owner(timeline)).data.items;
    assert.deepEqual(original.map((e: { action?: string; body?: string }) => e.action ?? e.body), ['joined', '会話の途中', 'left']);
    assert.equal(original[0].agent_name, '参加テスト');
    assert.equal(original[2].agent_name, '変更後');
    for (const event of [original[0], original[2]]) {
      assert.equal(event.account_name, 'satou');
      assert.equal(event.member_agent_id, null);
      assert.equal(event.agent_handle, 'room-agent');
      assert.equal(event.agent_platform, 'Muse');
    }
    for (let i = 0; i < 25; i++) {
      assert.equal((await join()).response.status, 201);
      assert.equal((await leave()).response.status, 200);
    }
    const latest = (await owner(timeline)).data;
    assert.equal(latest.items.length, 50);
    assert.equal(latest.has_more, true);
    const first = latest.items[0];
    const older = (await owner(timeline + '&before=' + first.seq + '.' + first.event_order)).data;
    assert.deepEqual(older.items, original);
    assert.equal(older.has_more, false);
    assert.deepEqual((await owner(path + '/messages')).data.messages.map((m: {id:string}) => m.id), [text]);
    assert.equal((await owner('/rooms')).data.rooms.find((r: {id:string}) => r.id === registeredRoom).unread_count, 0);
    await member('/blocks', 'POST', { account_name: 'examplehost' });
    assert.deepEqual((await owner(timeline)).data.items.map((m: {id:string}) => m.id), [text]);
    assert.equal((await member(timeline)).data.items.some((m: {id:string}) => m.id === text), false);
    await member('/blocks/' + ownerId, 'DELETE');
    await join();
    const roster = (await owner(path)).data.members;
    const human = roster.find((m: { account_name:string; kind:string }) => m.account_name === 'satou' && m.kind === 'human');
    const invitation = (await owner(path + '/invites','POST')).data.url;
    assert.equal((await owner(path + '/members/' + human.id,'DELETE')).response.status,200);
    assert.equal((await owner(path)).data.members.some((m: {user_id:string}) => m.user_id === human.user_id),false);
    assert.equal((await member(path+'/join','POST')).response.status,403);
    assert.equal((await member('/invites/'+invitation.split('/').pop()+'/accept','POST')).response.status,403);
    assert.equal((await join()).response.status,403);
    assert.equal((await owner(path, 'DELETE')).response.status, 200);
  });
  await t.test('inbox pages and normalized search cover rooms beyond the first page', async () => {
    for (let i=0; i<27; i++) {
      const room = await owner('/rooms','POST',{name:'Ｐａｇｅ試験 '+i,access_mode:'invite'});
      assert.equal(room.response.status,201);
    }
    const path = '/rooms?q=' + encodeURIComponent('page試験');
    const first = (await owner(path+'&offset=0')).data.rooms;
    const next = (await owner(path+'&offset=24')).data.rooms;
    assert.equal(first.length,24);
    assert.equal(next.length,3);
    assert.equal(new Set([...first,...next].map(room => room.id)).size,27);
    assert.deepEqual((await member(path+'&offset=0')).data.rooms,[]);
    assert.equal((await owner('/rooms?offset=-1')).response.status,400);
  });
  await t.test('registered AI can join without its owner, respecting invites and owner permission', async()=>{
    const agent=(await member('/agents','POST',{name:'Scout',handle:'scout',platform:'Test'})).data;
    const {token}=(await member('/agents/'+agent.id+'/connections','POST',{label:'test'})).data;
    const ai=new Client({name:'scout',version:'1'});
    await ai.connect(new StreamableHTTPClientTransport(new URL('/mcp',origin),{requestInit:{headers:{Authorization:'Bearer '+token}}}));
    try {
      const hostRoom=(await owner('/rooms','POST',{name:'Independent join',access_mode:'registered'})).data.id;
      const join=(id:string,invite_code?:string)=>ai.callTool({name:'join_room',arguments:{room_id:id,invite_code}});
      await member('/agents/'+agent.id,'PATCH',{autonomous_rooms:false});
      assert.ok((await join(hostRoom)).isError);
      await member('/agents/'+agent.id,'PATCH',{autonomous_rooms:true});
      assert.ok(!(await join(hostRoom)).isError);
      assert.equal((await member('/rooms/'+hostRoom)).response.status,403);
      assert.ok(!(await ai.callTool({name:'post_message',arguments:{room_id:hostRoom,body:'Independent scout'}})).isError);
      const updateAccess=(room_id:string,access_mode:string)=>ai.callTool({name:'update_room',arguments:{room_id,access_mode}});
      assert.ok((await updateAccess(hostRoom,'anonymous')).isError);
      const ownRoom=await ai.callTool({name:'create_room',arguments:{name:'Managed by Scout',request_id:crypto.randomUUID(),access_mode:'registered',directory_listed:true,tags:['original']}});
      const id=JSON.parse((ownRoom.content as {text:string}[])[0].text).room_id;
      const call=(name:string,args:Record<string,unknown>)=>ai.callTool({name,arguments:{room_id:id,...args}});
      const value=(r:Record<string,unknown>)=>JSON.parse((r.content as {text:string}[])[0].text);
      assert.ok(!(await ai.callTool({name:'set_profile',arguments:{name:'Scout II',profile_text:'Agent bio.'}})).isError);
      assert.equal(value(await call('get_member_profile',{kind:'agent',subject_id:agent.id})).bio,'Agent bio.');
      assert.ok((await ai.callTool({name:'set_profile',arguments:{daily_limit:199}})).isError);
      assert.ok(!(await call('create_room_invite',{})).isError);
      assert.ok((await call('create_room_invite',{room_id:hostRoom})).isError);
      assert.equal(value(await call('revoke_room_invites',{})).revoked,1);
      assert.ok((await call('delete_room',{confirm_name:'Wrong name'})).isError);
      assert.ok(!(await call('update_room',{directory_listed:false})).isError);
      assert.ok((await call('preview_public_room',{})).isError);
      assert.equal(value(await call('get_room',{})).directory_listed,false);
      assert.ok(!(await call('update_room',{directory_listed:true})).isError);
      const bytes=Buffer.alloc(512*1024,42);
      const chunk=value(await call('upload_attachment_chunk',{data:bytes.toString('base64')})).chunk_id;
      assert.ok(chunk);
      const media={request_id:crypto.randomUUID(),files:[{name:'example.bin',chunks:[chunk]}],sticker:'wave'};
      const mediaId=value(await call('post_media_message',media)).id;
      assert.ok(mediaId);
      assert.equal(value(await call('post_media_message',media)).id,mediaId);
      assert.ok((await call('post_media_message',{...media,room_id:hostRoom})).isError);
      const history=value(await call('read_messages',{})).messages;
      const file=history.find((m:{id:string})=>m.id===mediaId).attachments[0];
      assert.equal(file.size,bytes.length);
      assert.equal((await call('read_attachment',{attachment_id:file.id})).isError,undefined);
      assert.ok(!(await call('preview_public_room',{})).isError);
      assert.ok(!(await call('read_public_attachment',{attachment_id:file.id})).isError);
      const fullFile={name:'limit.bin',chunks:Array(50).fill(chunk)};
      assert.ok(!(await call('post_media_message',{request_id:crypto.randomUUID(),files:[fullFile]})).isError);
      assert.ok((await call('post_media_message',{request_id:crypto.randomUUID(),files:[fullFile,{name:'extra',chunks:[chunk]}]})).isError);
      assert.equal((await owner('/rooms/'+id+'/join','POST')).response.status,200);
      const people=value(await call('get_room_members',{})).members;
      const human=people.find((m:{kind:string})=>m.kind==='human');
      assert.ok(human.member_id);
      assert.ok((await call('remove_room_member',{room_id:hostRoom,member_id:human.member_id})).isError);
      assert.ok(!(await call('remove_room_member',{member_id:human.member_id})).isError);
      assert.equal((await owner('/rooms/'+id+'/join','POST')).response.status,403);
      assert.ok(!(await call('leave_room',{room_id:hostRoom})).isError);
      assert.ok((await call('get_room',{room_id:hostRoom})).isError);
      assert.ok(!(await join(hostRoom)).isError);
      assert.ok(!(await call('report_message',{message_id:mediaId,reason:'Fixture report.'})).isError);
      const path='/public/rooms/'+id;
      const visitor=client();
      const edit=(room_id:string,patch:Record<string,unknown>)=>ai.callTool({name:'update_room',arguments:{room_id,...patch}});
      assert.ok((await edit(id,{})).isError);
      assert.ok((await edit(id,{name:'  '})).isError);
      assert.ok((await edit(id,{name:'a'.repeat(81)})).isError);
      assert.ok((await edit(id,{description:'a'.repeat(501)})).isError);
      assert.ok((await edit(id,{name:'Invalid edit',tags:['has space']})).isError);
      assert.equal((await visitor(path)).data.room.name,'Managed by Scout');
      assert.ok(!(await edit(id,{name:'  Scout lounge  ',description:'A place to chat',tags:['Music','music']})).isError);
      const renamed=(await visitor(path)).data.room;
      assert.equal(renamed.name,'Scout lounge'); assert.equal(renamed.description,'A place to chat');
      assert.equal(renamed.access_mode,'registered');
      const catalog=(await visitor('/explore/rooms?tag=Music')).data.rooms;
      assert.deepEqual(catalog.find((r:{id:string})=>r.id===id)?.tags,['Music']);
      assert.ok(!(await edit(id,{description:'',tags:[]})).isError);
      assert.equal((await visitor(path)).data.room.description,'');
      assert.equal((await visitor('/explore/rooms?tag=Music')).data.rooms.some((r:{id:string})=>r.id===id),false);
      assert.ok(!(await edit(id,{tags:['original']})).isError);
      assert.equal((await visitor(path)).response.status,200);
      assert.equal((await visitor(path+'/session','POST')).response.status,404);
      assert.ok(!(await updateAccess(id,'anonymous')).isError);
      assert.ok(!(await updateAccess(id,'anonymous')).isError);
      assert.equal((await visitor(path)).response.status,200);
      assert.equal((await visitor(path+'/session','POST',{display_name:'Reader'})).response.status,201);
      assert.ok(!(await edit(id,{name:'Scout café'})).isError);
      assert.equal((await visitor(path+'/session')).data.active,true);
      assert.ok(!(await updateAccess(id,'registered')).isError);
      assert.equal((await visitor(path)).response.status,200);
      assert.equal((await visitor(path+'/session','POST')).response.status,404);
      assert.ok(!(await updateAccess(id,'anonymous')).isError);
      assert.equal((await visitor(path+'/session')).data.active,false);
      await member('/agents/'+agent.id,'PATCH',{autonomous_rooms:false});
      assert.ok((await updateAccess(id,'invite')).isError);
      assert.ok((await edit(id,{name:'Disabled attempt',tags:[]})).isError);
      assert.equal((await visitor(path)).data.room.name,'Scout café');
      assert.equal((await visitor(path)).response.status,200);
      await member('/agents/'+agent.id,'PATCH',{autonomous_rooms:true});
      assert.ok(!(await updateAccess(id,'invite')).isError);
      assert.equal((await visitor(path+'/messages')).response.status,404);
      const reopened=await updateAccess(id,'registered');
      assert.equal(JSON.parse((reopened.content as {text:string}[])[0].text).directory_listed,false);
      assert.equal((await member('/rooms/'+id+'/join','POST')).response.status,200);
      assert.deepEqual((await member('/rooms/'+id)).data.room.tags,['original']);
      const humanRoom=(await member('/rooms','POST',{name:'Same owner, human-created',access_mode:'anonymous'})).data.id;
      await join(humanRoom);
      const guestPath='/public/rooms/'+humanRoom+'/session';
      await visitor(guestPath,'POST',{display_name:'Reader'});
      assert.ok((await updateAccess(humanRoom,'invite')).isError);
      assert.ok((await edit(humanRoom,{name:'Wrong creator',tags:['unwanted']})).isError);
      const protectedRoom=(await member('/rooms/'+humanRoom)).data.room;
      assert.equal(protectedRoom.name,'Same owner, human-created'); assert.deepEqual(protectedRoom.tags,[]);
      assert.equal((await visitor(guestPath)).data.active,true);
      await member('/rooms/'+id+'/agents/'+agent.id,'DELETE');
      assert.ok((await updateAccess(id,'anonymous')).isError);
      assert.ok((await edit(id,{name:'Left',tags:[]})).isError);
      const privateRoom=(await owner('/rooms','POST',{name:'Private independent join',access_mode:'invite'})).data.id;
      assert.ok((await join(privateRoom)).isError);
      const invitation=(await owner('/rooms/'+privateRoom+'/invites','POST')).data.url.split('/').pop();
      assert.ok(!(await join(privateRoom,invitation)).isError);
      assert.equal((await member('/rooms/'+privateRoom)).response.status,403);
    } finally { await ai.close(); }
  });
  await t.test('guests can originate rooms and chat without a registered participant',async()=>{
    const ai=new Client({name:'creator',version:'1'});
    const transport=new StreamableHTTPClientTransport(new URL('/api/public/mcp',origin));
    await ai.connect(transport);
    try {
      const result=await ai.callTool({name:'create_room',arguments:{name:'Guest AI room',display_name:'Guest bot'}});
      assert.ok(!result.isError,JSON.stringify(result.content));
      const room=JSON.parse((result.content as {text:string}[])[0].text).room_id;
      const edit=(patch:Record<string,unknown>)=>ai.callTool({name:'update_room',arguments:patch});
      assert.ok(!(await edit({room_id:room,name:'Guest lounge',description:'Guest edited',tags:['Welcome']})).isError);
      assert.ok((await edit({room_id:'another-room',name:'Wrong room'})).isError);
      assert.ok((await edit({access_mode:'invite',name:'Private lounge'})).isError);
      assert.ok((await edit({name:'Broken edit',tags:['has space']})).isError);
      const guestRoom=(await client()('/public/rooms/'+room)).data.room;
      assert.equal(guestRoom.name,'Guest lounge'); assert.equal(guestRoom.description,'Guest edited');
      assert.equal(guestRoom.access_mode,'anonymous');
      assert.ok(!(await edit({name:'Guest lounge again'})).isError);
      assert.deepEqual((await client()('/explore/rooms?tag=Welcome')).data.rooms.find((r:{id:string})=>r.id===room)?.tags,['Welcome']);
      assert.ok(!(await ai.callTool({name:'post_message',arguments:{body:'Agent-only hello'}})).isError);
      const catalog=await (await fetch(origin+'/api/explore/rooms')).json() as {rooms:{id:string;human_count:number;agent_count:number}[]};
      const row=catalog.rooms.find(r=>r.id===room);
      assert.equal(row?.human_count,0);assert.equal(row?.agent_count,1);
      assert.equal((await owner('/rooms/'+room)).response.status,403);
      const remove=await ai.callTool({name:'delete_room',arguments:{confirm_name:'Guest lounge again'}});
      assert.ok(!remove.isError,JSON.stringify(remove.content));
      assert.equal((await client()('/public/rooms/'+room)).response.status,404);
    } finally {await ai.close();}
    const creator = client();
    const draft = {request_id:crypto.randomUUID(),name:'Guest human room',display_name:'Guest host',image};
    assert.equal((await creator('/public/rooms','POST',{...draft,image:{}})).response.status,400);
    const created = await creator('/public/rooms','POST',draft);
    assert.equal(created.response.status,201);
    const path = '/public/rooms/' + created.data.room_id;
    const session = (await creator(path+'/session')).data;
    assert.equal(session.active,true); assert.equal(session.display_name,'Guest host');
    assert.equal((await creator(path)).data.room.host_display_name,'Guest host');
    assert.equal((await fetch(origin+'/api'+path+'/images/user/'+session.user_id)).status,200);
    assert.equal((await creator('/public/rooms','POST',draft)).data.room_id,created.data.room_id);
    assert.equal((await creator(path+'/session')).data.user_id,session.user_id);
  });
  await t.test('a guest discovers and joins a listed room on one lobby connection', async () => {
    const makeRoom = async (name:string, mode:string, listed=true) => (await owner('/rooms','POST',
      {name, access_mode:mode, directory_listed:listed, tags:['lobby']})).data.id;
    const open = await makeRoom('Introductions','anonymous');
    const closed = await makeRoom('Accounts only','registered');
    const hidden = await makeRoom('Direct links only','anonymous',false);
    const ai = new Client({name:'visitor',version:'1'});
    await ai.connect(new StreamableHTTPClientTransport(new URL('/api/public/mcp',origin)));
    const call = (name:string,args:Record<string,unknown>={}) => ai.callTool({name,arguments:args});
    const join = (room_id:string) => call('join_room',{room_id,name:'Visitor',image});
    try {
      const catalog = await call('list_public_rooms',{tag:'lobby'});
      const data = JSON.parse((catalog.content as {text:string}[])[0].text);
      assert.deepEqual(new Set(data.rooms.map((r:{room_id:string}) => r.room_id)),new Set([open,closed]));
      assert.equal(data.rooms.find((r:{room_id:string}) => r.room_id===closed).guest_joinable,false);
      assert.ok((await join(closed)).isError);
      assert.ok((await join(hidden)).isError);
      assert.ok((await call('post_message',{body:'Before join'})).isError);
      const joined = await join(open);
      assert.ok(!joined.isError,JSON.stringify(joined.content));
      assert.deepEqual((await join(open)).content,joined.content);
      assert.ok((await call('update_room',{name:'Foreign guest edit',tags:[]})).isError);
      const original = (await owner('/rooms/'+open)).data.room;
      assert.equal(original.name,'Introductions'); assert.deepEqual(original.tags,['lobby']);
      assert.ok((await join(hidden)).isError);
      assert.ok((await call('create_room',{name:'Second room',display_name:'Visitor'})).isError);
      assert.ok(!(await call('post_message',{body:'Hello from the lobby'})).isError);
      const messages = await call('read_messages');
      assert.equal(JSON.parse((messages.content as {text:string}[])[0].text).messages[0].body,'Hello from the lobby');
      assert.equal((await owner('/rooms/'+open)).data.members.filter((m:{kind:string}) => m.kind==='agent').length,1);
      assert.ok(!(await call('leave_room')).isError);
      assert.equal((await owner('/rooms/'+open)).data.members.filter((m:{kind:string}) => m.kind==='agent').length,0);
    } finally {await ai.close();}
  });
  await t.test('guest AI joins without OAuth and remains scoped to one anonymous room',async()=>{
    const room=(await owner('/rooms','POST',{name:'Guest AI test',access_mode:'anonymous'})).data.id;
    const path='/public/rooms/'+room;
    const endpoint=new URL('/api'+path+'/mcp',origin);
    const ai=new Client({name:'guest-fixture',version:'1'});
    const transport=new StreamableHTTPClientTransport(endpoint);
    await ai.connect(transport);
    try {
      assert.ok(transport.sessionId);
      assert.deepEqual((await ai.listTools()).tools.map(t=>t.name).sort(),['create_room_invite', 'delete_message', 'delete_room', 'edit_message', 'get_identity', 'get_member_profile', 'get_my_webhook', 'get_reply_status', 'get_room', 'get_room_members', 'get_verification_note', 'join_room', 'leave_room', 'post_media_message', 'post_message', 'read_attachment', 'read_messages', 'read_room_timeline', 'remove_my_webhook', 'remove_room_member', 'report_message', 'revoke_room_invites', 'search_messages', 'set_my_webhook', 'set_profile', 'set_reaction', 'set_reply_status', 'update_room', 'update_verification_note', 'upload_attachment_chunk']);
      assert.equal((await ai.callTool({name:'read_messages',arguments:{}})).isError,true);
      const joined=await ai.callTool({name:'join_room',arguments:{name:'Visitor AI',image}});
      assert.ok(!joined.isError,JSON.stringify(joined.content));
      const agentId=JSON.parse((joined.content as Array<{text:string}>)[0].text).agent_id;
      assert.equal((await fetch(origin+'/api'+path+'/images/agent/'+agentId)).status,200);
      assert.ok(!(await ai.callTool({name:'set_profile',arguments:{name:'Guest bot',image:null}})).isError);
      assert.equal((await fetch(origin+'/api'+path+'/images/agent/'+agentId)).status,404);
      assert.ok(!(await ai.callTool({name:'post_message',arguments:{body:'guest AI hello'}})).isError);
      const read=await ai.callTool({name:'read_messages',arguments:{}});
      const [msg]=JSON.parse((read.content as Array<{text:string}>)[0].text).messages;
      assert.equal(msg.author_agent_id,agentId);
      assert.equal(msg.agent_name,'Guest bot');
      assert.equal(msg.is_guest,1);
      const own=(name:string,args:Record<string,unknown>)=>ai.callTool({name,arguments:args});
      assert.ok(!(await own('edit_message',{message_id:msg.id,body:'Corrected guest message'})).isError);
      assert.ok(!(await own('search_messages',{query:'Corrected'})).isError);
      assert.ok(!(await own('set_reaction',{message_id:msg.id,emoji:'👍'})).isError);
      assert.ok((await own('edit_message',{room_id:'another-room',message_id:msg.id,body:'Wrong room'})).isError);
      assert.ok((await own('delete_room',{confirm_name:'Second guest room'})).isError);
      assert.ok(!(await own('delete_message',{message_id:msg.id})).isError);
      const other=(await owner('/rooms','POST',{name:'Second guest room',access_mode:'anonymous'})).data.id;
      const cross=await fetch(origin+'/api/public/rooms/'+other+'/mcp',{method:'POST',headers:{...callHeaders,'Mcp-Session-Id':transport.sessionId!},body:JSON.stringify({jsonrpc:'2.0',method:'tools/list',id:1})});
      assert.equal(cross.status,404);
      const pathToRoom='/rooms/'+room;
      assert.equal((await owner(pathToRoom+'/access','PATCH',{access_mode:'registered'})).response.status,200);
      assert.equal((await fetch(endpoint)).status,404);
      assert.equal((await owner(pathToRoom+'/access','PATCH',{access_mode:'anonymous'})).response.status,200);
      assert.equal((await fetch(endpoint,{method:'DELETE',headers:{'Mcp-Session-Id':transport.sessionId!}})).status,404);
      assert.equal((await owner(pathToRoom)).data.members.some((m:{agent_id:string})=>m.agent_id===agentId),false);
      const departing=new Client({name:'leaving-guest',version:'1'});
      const otherEndpoint=new URL('/api/public/rooms/'+other+'/mcp',origin);
      const otherTransport=new StreamableHTTPClientTransport(otherEndpoint);
      await departing.connect(otherTransport);
      try {
        const result=await departing.callTool({name:'join_room',arguments:{name:'Departing AI'}});
        assert.ok(!result.isError);
        assert.ok(!(await departing.callTool({name:'leave_room',arguments:{}})).isError);
        assert.equal((await fetch(otherEndpoint,{method:'DELETE',headers:{'Mcp-Session-Id':otherTransport.sessionId!}})).status,404);
      } finally {await departing.close();}
    } finally {await ai.close();}
  });
  await t.test('an active legacy MCP session keeps its history when upgraded and after reconnect', async t => {
    const room = (await owner('/rooms','POST',{name:'Identity migration',access_mode:'anonymous',directory_listed:true})).data.id;
    const lobby = new URL('/api/public/mcp',origin);
    async function connect(key?:string) {
      const ai = new Client({name:'migration-fixture',version:'1'});
      await ai.connect(new StreamableHTTPClientTransport(lobby,{requestInit:{headers:{
        'CF-Connecting-IP':'192.0.2.90', ...(key ? {Authorization:'Bearer '+key} : {}),
      }}}));
      t.after(() => ai.close());
      return ai;
    }
    const call = async (ai:Client,name:string,args:Record<string,unknown>={}) => {
      const result = await ai.callTool({name,arguments:args});
      assert.ok(!result.isError,name);
      return JSON.parse((result.content as {text:string}[])[0].text);
    };
    const original = await connect();
    const joined = await call(original,'join_room',{room_id:room,name:'Returning agent'});
    assert.match(joined.handle,/^agent-[a-f0-9]+$/);
    assert.match(joined.key,/^agk_[A-Za-z0-9_-]{43}$/);
    const message = await call(original,'post_message',{body:'Written before migration'});
    // Restore the database shape of an enrolled agent from before automatic handles.
    assert.match(joined.agent_id,/^[0-9a-f-]{36}$/);
    const seed = spawnSync(wrangler,['d1','execute','a2aroom-test','--local','--persist-to',fixture.state,
      '--config',fixture.configPath,'--command',`DELETE FROM guest_agent_handles WHERE agent_id='${joined.agent_id}'`],{encoding:'utf8'});
    assert.equal(seed.status,0,seed.stderr);
    await call(original,'read_messages');
    const profile = (await client()('/public/rooms/'+room+'/profiles/agent/'+joined.agent_id)).data;
    const identity = await call(original,'get_identity');
    assert.equal(profile.guest_handle,identity.handle);
    assert.equal(profile.name,'Returning agent');
    assert.equal(identity.agent_id,joined.agent_id);
    assert.deepEqual(await call(original,'get_identity'),identity);
    const returned = await connect(identity.key);
    assert.equal((await call(returned,'join_room',{room_id:room})).agent_id,joined.agent_id);
    await call(original,'leave_room');
    const {messages} = await call(returned,'read_messages',{room_id:room});
    assert.ok(messages.some((m:{id:string;guest_handle:string;author_agent_id:string}) =>
      m.id===message.id && m.author_agent_id===joined.agent_id && m.guest_handle===identity.handle));
    assert.ok((await returned.callTool({name:'join_room',arguments:{room_id:registered.data.id}})).isError);
    await call(returned,'leave_room',{room_id:room});
    assert.equal((await client()('/public/rooms/'+room+'/profiles/agent/'+joined.agent_id)).response.status,404);
  });
  await t.test('named guest identity survives reconnects and only participates in guest rooms', async t => {
    const lobby = new URL('/api/public/mcp', origin);
    const connect = async (endpoint: URL, key?:string) => {
      const ai = new Client({name:'handle-fixture',version:'1'});
      const transport = new StreamableHTTPClientTransport(endpoint, {requestInit:{headers:{
        'CF-Connecting-IP':'192.0.2.84', ...(key ? {Authorization:'Bearer '+key} : {}),
      }}});
      await ai.connect(transport);
      t.after(() => ai.close());
      return ai;
    };
    const call = (ai:Client,name:string,args:Record<string,unknown>={}) => ai.callTool({name,arguments:args});
    const value = (r:Awaited<ReturnType<typeof call>>) => {
      assert.ok(!r.isError);
      return JSON.parse((r.content as {text:string}[])[0].text);
    };
    const [anon,second] = await Promise.all([connect(lobby),connect(lobby)]);
    const claims = await Promise.all([call(anon,'claim_handle',{handle:'Test-Scout'}),call(second,'claim_handle',{handle:'test-scout'})]);
    const winner = claims[0].isError ? 1 : 0;
    assert.equal(claims[1-winner].isError,true);
    const identity = value(claims[winner]);
    assert.equal(identity.handle,'test-scout');
    assert.match(identity.key,/^agk_[A-Za-z0-9_-]{43}$/);
    assert.ok((await call([anon,second][winner],'claim_handle',{handle:'another-scout'})).isError);
    assert.ok((await call([anon,second][winner],'create_room',{name:'Extra room',display_name:'Duplicate'})).isError);
    const rpcBody=JSON.stringify({id:1,jsonrpc:'2.0',method:'tools/list'});
    assert.equal((await fetch(origin+'/mcp',{method:'POST',headers:{...callHeaders,Authorization:'Bearer '+identity.key},body:rpcBody})).status,401);
    assert.equal((await fetch(lobby,{method:'POST',headers:{...callHeaders,Authorization:'Bearer invalid'},body:rpcBody})).status,401);
    const named=await connect(lobby,identity.key);
    const names=(await named.listTools()).tools.map(t=>t.name);
    for(const protectedName of ['claim_handle','create_room','update_room','delete_room','set_my_webhook','set_profile','remove_room_member'])
      assert.ok(!names.includes(protectedName), protectedName);
    const first=(await owner('/rooms','POST',{name:'Handle room A',access_mode:'anonymous',directory_listed:true})).data.id;
    const hidden=(await owner('/rooms','POST',{name:'Handle room B',access_mode:'anonymous',directory_listed:false})).data.id;
    for(const room_id of [registered.data.id,invite.data.id,hidden]) assert.ok((await call(named,'join_room',{room_id})).isError);
    assert.ok((await call(named,'post_message',{room_id:first,body:'Before joining'})).isError);
    const joined=value(await call(named,'join_room',{room_id:first}));
    assert.equal(joined.agent_id,identity.agent_id);
    const m=value(await call(named,'post_message',{room_id:first,body:'Hello from a fixed identity'}));
    const returned=await connect(lobby,identity.key);
    const historic=value(await call(returned,'read_messages',{room_id:first})).messages;
    assert.ok(historic.some((p:{id:string; author_agent_id:string;agent_name:string})=>p.id===m.id && p.author_agent_id===identity.agent_id && p.agent_name==='test-scout'));
    assert.equal(value(await call(returned,'get_member_profile',{room_id:first,kind:'agent',subject_id:identity.agent_id})).guest_handle,'test-scout');
    assert.ok(!(await call(returned,'edit_message',{room_id:first,message_id:m.id,body:'Correction'})).isError);
    const noteTarget = {room_id:first,message_id:m.id};
    const steps = 'Observe the named guest test fixture';
    assert.equal(value(await call(returned,'update_verification_note',{...noteTarget,change:{kind:'evidence',source_url:'',steps}})).saved,true);
    assert.equal(value(await call(returned,'get_verification_note',noteTarget)).steps,steps);
    assert.ok(value(await call(returned,'search_verification_archive',{query:steps})).notes.some((n:{message_id:string})=>n.message_id===m.id));
    const direct=await connect(new URL('/api/public/rooms/'+hidden+'/mcp',origin),identity.key);
    assert.equal(value(await call(direct,'join_room')).agent_id,identity.agent_id);
    assert.ok((await call(direct,'get_room',{room_id:first})).isError);
    assert.ok(!(await call(direct,'post_message',{body:'Same agent in another room'})).isError);
    assert.ok(!(await call(direct,'leave_room')).isError);
    assert.ok((await call(direct,'read_messages')).isError);
    assert.ok(!(await call(returned,'read_messages',{room_id:first})).isError);
    await owner('/rooms/'+first+'/access','PATCH',{access_mode:'registered'});
    assert.ok((await call(returned,'read_messages',{room_id:first})).isError);
    assert.ok((await call(returned,'join_room',{room_id:first})).isError);
  });

});

test('room media, stickers, ranges, reactions and deletion respect room visibility', { timeout: 120_000 }, async (t) => {
  const fixture = await startFixture({ publicAccess: true });
  t.after(async () => {
    fixture.child.kill('SIGTERM');
    if (fixture.child.exitCode === null) await new Promise(resolve => fixture.child.once('exit', resolve));
    await rm(fixture.directory, { recursive: true, force: true });
  });
  const { origin } = fixture;
  const client = (account?:string) => {
    let {cookie,csrf} = account ? seedSession(fixture,account) : {cookie:'',csrf:''};
    return async (path: string, method = 'GET', value?: unknown, headers: Record<string, string> = {}) => {
      const multipart = value instanceof FormData;
      const response = await fetch(origin + '/api' + path, {
        method, headers: { Origin: origin, Cookie: cookie, 'X-CSRF-Token': csrf,
          ...(value !== undefined && !multipart ? { 'Content-Type': 'application/json' } : {}), ...headers },
        body: multipart ? value : JSON.stringify(value),
      });
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      if (response.headers.get('Content-Type')?.includes('application/json')) {
        const json = await response.clone().json() as { csrf?: string };
        if (json.csrf) csrf = json.csrf;
      }
      return response;
    };
  };
  const owner = client('examplehost'), second = client('media-member'), guest = client();
  async function id(response: Response, status = 201) {
    const data = await response.json() as { id?: string; error?: string };
    assert.equal(response.status, status, data.error ?? response.statusText);
    assert.ok(data.id);
    return data.id;
  }
  const room = '/rooms/' + await id(await owner('/rooms', 'POST', { name: 'Media', access_mode: 'registered' }));
  const publicRoom = '/rooms/' + await id(await owner('/rooms', 'POST', { name: 'Open media', access_mode: 'anonymous' }));
  const parent = await id(await owner(room + '/messages', 'POST', { body: '添付をお願いします' }));
  const png = new Uint8Array(syntheticPng(817));
  const clip = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0]);
  const form = new FormData();
  form.set('request_id', crypto.randomUUID());
  form.set('reply_to', parent);
  form.append('files', new Blob([png]), '画像.png');
  form.append('files', new Blob([clip]), '動画.mp4');
  form.append('files', new Blob(['記録'], { type: 'text/plain' }), '記録.txt');
  const postPath = room + '/media-messages';
  assert.equal((await owner(postPath, 'POST', form, { 'X-CSRF-Token': '' })).status, 403);
  const mediaId = await id(await owner(postPath, 'POST', form));
  assert.equal(await id(await owner(postPath, 'POST', form)), mediaId);
  form.set('request_id', crypto.randomUUID());
  assert.equal((await owner(postPath, 'POST', form)).status, 409);
  const history = await (await owner(room + '/messages')).json() as { messages: Array<{
    id: string; reply_to: string; reply_excerpt: string; reply_author: string; media_label_only: number; attachments: {id: string; kind: string}[];
  }> };
  assert.equal(history.messages.length, 2);
  const m = history.messages[1];
  assert.equal(m.reply_to, parent);
  assert.equal(m.reply_excerpt, '添付をお願いします');
  assert.equal(m.reply_author, 'examplehost');
  assert.equal(m.media_label_only, 1);
  assert.deepEqual(m.attachments.map(a => a.kind), ['photo', 'video', 'file']);
  const [photo, video, doc] = m.attachments.map(f => room + '/attachments/' + f.id);
  assert.equal((await guest(photo)).status, 401);
  assert.equal((await second(photo)).status, 404);
  assert.equal((await guest('/public' + room + '/attachments/' + m.attachments[0].id)).status, 200);
  assert.equal((await owner(publicRoom + '/attachments/' + m.attachments[0].id)).status, 404);
  const agent = await id(await second('/agents', 'POST', { name: 'Muse', handle: 'muse', platform: 'Muse' }));
  const connection = await (await second('/agents/' + agent + '/connections', 'POST', { label: 'attachment test' })).json() as { token: string };
  const reader = new Client({ name: 'media-reader', version: '1' });
  await reader.connect(new StreamableHTTPClientTransport(new URL('/mcp', origin), { requestInit: { headers: { Authorization: 'Bearer ' + connection.token } } }));
  t.after(() => reader.close());
  const readAttachment = (roomPath = room, index = 0, offset?: number) => reader.callTool({
    name: 'read_attachment', arguments: { room_id: roomPath.slice(7), attachment_id: m.attachments[index].id, offset },
  });
  assert.equal((await readAttachment()).isError, true);
  const image = await owner(photo);
  assert.equal(image.headers.get('Content-Type'), 'image/png');
  assert.deepEqual(new Uint8Array(await image.arrayBuffer()), png);
  const part = await owner(video, 'GET', undefined, { Range: 'bytes=4-11' });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('Content-Range'), 'bytes 4-11/16');
  assert.deepEqual(new Uint8Array(await part.arrayBuffer()), clip.slice(4, 12));
  assert.equal((await owner(video, 'GET', undefined, { Range: 'bytes=-3' })).headers.get('Content-Length'), '3');
  assert.equal((await owner(video, 'GET', undefined, { Range: 'bytes=1000-' })).status, 416);
  const document = await owner(doc);
  assert.match(document.headers.get('Content-Disposition') ?? '', /^attachment/);
  assert.equal(document.headers.get('Content-Type'), 'application/octet-stream');
  assert.equal(await document.text(), '記録');
  assert.equal((await second(room + '/join', 'POST')).status, 200);
  assert.equal((await second(room + '/agents', 'POST', { agent_id: agent })).status, 201);
  const photoResult = await readAttachment();
  assert.deepEqual(photoResult.content, [{ type: 'image', mimeType: 'image/png', data: Buffer.from(png).toString('base64') }]);
  assert.equal((await readAttachment(publicRoom)).isError, true);
  const videoPart = (await readAttachment(room, 1, 4)).content as {type:string;resource?:{blob:string}}[];
  assert.equal(videoPart[1].resource?.blob, Buffer.from(clip.slice(4)).toString('base64'));
  const react = room + '/messages/' + mediaId + '/reaction';
  assert.equal((await second(react, 'PUT', { emoji: 'unknown' })).status, 400);
  assert.equal((await second(react, 'PUT', { emoji: '❤️' })).status, 200);
  assert.deepEqual(await (await owner(react, 'PUT', { emoji: '❤️' })).json(), { reactions: [{ emoji: '❤️', count: 2, mine: true }] });
  const changed = await (await second(react, 'PUT', { emoji: '👍' })).json() as { reactions: { emoji: string; mine: boolean }[] };
  assert.deepEqual(changed.reactions.find(r => r.mine)?.emoji, '👍');
  assert.deepEqual(await (await second(react, 'PUT', { emoji: null })).json(), { reactions: [{ emoji: '❤️', count: 1, mine: false }] });
  assert.equal((await second('/blocks', 'POST', { account_name: 'examplehost' })).status, 201);
  assert.equal((await second(photo)).status, 404);
  assert.equal((await readAttachment()).isError, true);
  assert.equal((await second(react, 'PUT', { emoji: '👍' })).status, 404);
  assert.equal((await owner('/messages/' + mediaId, 'DELETE')).status, 200);
  assert.equal((await owner(photo)).status, 404);
  assert.equal((await owner(react, 'PUT', { emoji: '❤️' })).status, 404);
  const invalid = new FormData();
  invalid.set('request_id', crypto.randomUUID());
  invalid.set('sticker', 'missing');
  assert.equal((await owner(postPath, 'POST', invalid)).status, 400);
  invalid.delete('sticker');
  for (let i = 0; i < 5; i++) invalid.append('files', new Blob(['x']), i + '.txt');
  assert.equal((await owner(postPath, 'POST', invalid)).status, 400);

  const large = new FormData();
  const limit = 25 * 1024 * 1024;
  large.set('request_id', crypto.randomUUID());
  large.append('files', new Blob([new Uint8Array(limit)]), 'limit.bin');
  await id(await owner(postPath, 'POST', large));
  large.append('files', new Blob(['x']), 'extra.txt');
  assert.equal((await owner(postPath, 'POST', large)).status, 400);
  const guestPath = '/public' + publicRoom;
  assert.equal((await guest(guestPath + '/session', 'POST')).status, 201);
  const sticker = new FormData();
  sticker.set('request_id', crypto.randomUUID()); sticker.set('sticker', 'wave');
  const stickerId = await id(await guest(guestPath + '/media-messages', 'POST', sticker));
  const guestHistory = await (await guest(guestPath + '/messages')).json() as { messages: { sticker_id: string; body: string }[] };
  assert.equal(guestHistory.messages[0].sticker_id, 'wave');
  assert.match(guestHistory.messages[0].body, /やっほー/);
  assert.equal((await guest(guestPath + '/messages/' + stickerId + '/reaction', 'PUT', { emoji: '👏' })).status, 200);
  sticker.delete('sticker'); sticker.set('request_id', crypto.randomUUID());
  sticker.append('files', new Blob(['public']), 'public.txt');
  await id(await guest(guestPath + '/media-messages', 'POST', sticker));
  const guestFiles = await (await guest(guestPath + '/messages')).json() as { messages: { attachments: { id: string }[] }[] };
  const path = guestPath + '/attachments/' + guestFiles.messages[1].attachments[0].id;
  assert.equal(await (await guest(path)).text(), 'public');
  assert.equal((await owner(publicRoom + '/access', 'PATCH', { access_mode: 'invite' })).status, 200);
  assert.equal((await guest(path)).status, 404);
  assert.equal((await owner(publicRoom, 'DELETE')).status, 200);

  const queue = () => {
    const ret = spawnSync(wrangler, ['d1', 'execute', 'a2aroom-test', '--local', '--persist-to', fixture.state,
      '--config', fixture.configPath, '--command', 'SELECT COUNT(*) AS count FROM media_cleanup WHERE due_at=0', '--json'], { encoding: 'utf8' });
    assert.equal(ret.status, 0);
    return JSON.parse(ret.stdout)[0].results[0].count;
  };
  assert.equal(queue(), 4);
  assert.equal((await fetch(origin + '/__scheduled')).status, 200);
  assert.equal(queue(), 0);
});
