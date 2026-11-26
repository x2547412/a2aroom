import ipaddr from 'ipaddr.js';
import { HttpError, type Bindings } from './types';
import { visible, wakePayload } from './wakes';

function invalid() { return new HttpError(400, 'INVALID_WEBHOOK', '公開HTTPSアドレスを指定してください。'); }
async function resolvePublic(host: string, type: 'A' | 'AAAA') {
  const url = new URL('https://cloudflare-dns.com/dns-query');
  url.search = new URLSearchParams({ name: host, type }).toString();
  const res = await fetch(url, { headers: { Accept: 'application/dns-json' }, signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error('dns_unavailable');
  const data = await res.json() as { Status: number; Answer?: { type: number; data: string }[] };
  if (data.Status !== 0) throw invalid();
  return (data.Answer ?? []).filter(a => a.type === (type === 'A' ? 1 : 28)).map(a => a.data);
}
export async function webhookTarget(input: unknown, resolve = resolvePublic) {
  if (typeof input !== 'string' || input.length > 2048) throw invalid();
  let url: URL;
  try { url = new URL(input); } catch { throw invalid(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw invalid();
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: string[];
  if (ipaddr.isValid(host)) addresses = [host];
  else {
    if (!host.includes('.') || /(?:^|\.)(?:localhost|internal|local)\.?$/i.test(host)) throw invalid();
    addresses = (await Promise.all([resolve(host, 'A'), resolve(host, 'AAAA')])).flat();
  }
  if (!addresses.length || addresses.some(value => {
    if (!ipaddr.isValid(value)) return true;
    const ip = ipaddr.parse(value);
    return ip.range() !== 'unicast' || (ip.kind() === 'ipv6' && (ip.toByteArray()[0] & 0xe0) !== 0x20);
  })) throw invalid();
  return { url, host, address: addresses[0] };
}
export async function signedHeaders(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(timestamp + '.' + body));
  const hex = Array.from(new Uint8Array(mac), n => n.toString(16).padStart(2, '0')).join('');
  return { 'X-A2ARoom-Timestamp': String(timestamp), 'X-A2ARoom-Signature': 'v1=' + hex };
}

// Verify all DNS answers again on every delivery attempt.
export async function postWebhook(input: string, secret: string, body: string, environment: string) {
  const { url, host, address } = await webhookTarget(input);
  const headers = await signedHeaders(secret, body);
  // Hosted Workers route global fetch through the public Internet, including for
  // Cloudflare-proxied receivers. Local workerd can reach the host's LAN, so
  // pin its socket to the exact address checked above.
  if (environment === 'production') {
    if (!Cloudflare.compatibilityFlags.global_fetch_strictly_public) throw new Error('public_egress_required');
    const response = await fetch(url.href, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body,
      redirect: 'manual', signal: AbortSignal.timeout(8000),
    });
    await response.body?.cancel();
    return response.status;
  }
  const { connect } = await import('cloudflare:sockets');
  let socket = connect({ hostname: address, port: Number(url.port || 443) }, { secureTransport: 'starttls', allowHalfOpen: false });
  const timer = setTimeout(() => { void socket.close(); }, 8000);
  try {
    await socket.opened;
    socket = socket.startTls({ expectedServerHostname: host });
    await socket.opened;
    const bytes = new TextEncoder().encode(body);
    const head = ['POST ' + url.pathname + url.search + ' HTTP/1.1', 'Host: ' + url.host,
      'Content-Type: application/json', 'Content-Length: ' + bytes.length, 'Connection: close',
      ...Object.entries(headers).map(([key, value]) => key + ': ' + value), '', ''].join('\r\n');
    const writer = socket.writable.getWriter();
    await writer.write(new TextEncoder().encode(head + body));
    const reader = socket.readable.getReader();
    let firstLine = '';
    while (firstLine.length < 4096) {
      const part = await reader.read();
      if (part.done) break;
      firstLine += new TextDecoder().decode(part.value.subarray(0, 4096));
      if (firstLine.includes('\r\n')) {
        const status = /^HTTP\/1\.[01] (\d{3})(?: [^\r\n]*)?\r\n/.exec(firstLine);
        if (status) return Number(status[1]);
        break;
      }
    }
    throw new Error('invalid_http_response');
  } finally { clearTimeout(timer); await socket.close(); }
}

const backoff = [10_000, 60_000, 300_000];
export async function deliverOne(env: Bindings, agent: string, post = postWebhook, now = Date.now()) {
  // Claim atomically. A dead worker's lease becomes eligible again, including after a restart.
  const job = await env.DB.prepare(`UPDATE agent_wakes SET due_at = ?, attempts = attempts + 1
    WHERE agent_id = ? AND seq = (SELECT seq FROM agent_wakes WHERE agent_id = ? AND due_at <= ? ORDER BY due_at, seq LIMIT 1)
    RETURNING seq, generation, attempts`).bind(now + 60_000, agent, agent, now).first<{ seq: number; generation: string; attempts: number }>();
  if (!job) return false;
  const hook = await env.DB.prepare('SELECT url, secret FROM agent_webhooks WHERE agent_id = ? AND generation = ? AND enabled = 1')
    .bind(agent, job.generation).first<{ url: string; secret: string }>();
  const row = (await visible(env, agent, ' AND e.seq = ?', job.seq)).results[0];
  let status: number | null = null;
  if (hook && row) {
    try { status = await post(hook.url, hook.secret, JSON.stringify(wakePayload(row)), env.ENVIRONMENT); }
    catch { /* DNS, TLS and timeout failures have no HTTP status. Record the attempt below. */ }
  }
  const success = status !== null && status >= 200 && status < 300;
  const exhausted = job.attempts > backoff.length;
  const next = hook && row && !success && !exhausted ? Date.now() + backoff[job.attempts - 1] : null;
  const statements = [env.DB.prepare('UPDATE agent_wakes SET due_at = ? WHERE agent_id = ? AND seq = ? AND attempts = ? AND due_at IS NOT NULL')
    .bind(next, agent, job.seq, job.attempts)];
  if (hook && row) {
    statements.push(env.DB.prepare('INSERT INTO webhook_logs(agent_id, created_at, attempt, success, status) VALUES(?,?,?,?,?)')
      .bind(agent, Date.now(), job.attempts, Number(success), status));
    if (!success && exhausted) {
      statements.push(env.DB.prepare(`INSERT INTO notifications(id,user_id,kind,body,created_at)
        SELECT ?, a.owner_id, 'webhook_disabled', a.name || 'の新着通知を配送できなかったため、Webhookを停止しました。', ?
        FROM agents a JOIN agent_webhooks w ON a.id = w.agent_id WHERE a.id = ? AND w.generation = ? AND w.enabled = 1`)
        .bind(crypto.randomUUID(), Date.now(), agent, job.generation),
        env.DB.prepare('UPDATE agent_webhooks SET enabled = 0 WHERE generation = ?').bind(job.generation),
        env.DB.prepare('UPDATE agent_wakes SET due_at = NULL WHERE agent_id = ? AND generation = ? AND due_at IS NOT NULL').bind(agent, job.generation));
    }
  }
  await env.DB.batch(statements);
  return true;
}
