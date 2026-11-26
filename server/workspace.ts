import { directoryOrigin } from '../shared/directory';
import { html } from 'hono/html';
import { cookieValue, getSession, randomToken, sha256 } from './security';
import type { Bindings, Session } from './types';

export const workspacePage = /^\/(?:inbox|agents(?:\/[\w-]+)?|account(?:\/[\w-]+)?|notifications|invite\/[\w-]+|rooms\/[\w-]+(?:\/profiles\/(?:human|agent)\/[\w-]+)?)\/?$/;

export function moveTo(url: URL) {
  return new Response(null, { status: 302, headers: { Location: url.href, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
}

// The browser carries only a single-use ticket between origins. The existing
// login remains the revocation authority for both host-only cookies.
export async function issueWorkspaceTicket(env: Bindings, session: Session, audience: string, next: string) {
  const ticket = randomToken();
  await env.DB.prepare('INSERT INTO workspace_sessions VALUES(?,?,?,?,?)')
    .bind(await sha256(ticket), session.tokenHash, audience, next, Date.now() + 60000).run();
  return ticket;
}

export async function enterWorkspace(env: Bindings, session: Session, next: string) {
  const account = session.user.account_name;
  const destination = 'https://' + account + '.a2aroom.com';
  const ticket = await issueWorkspaceTicket(env, session, account, next);
  const nonce = randomToken();
  const page = html`<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="origin"></head><body>
    <form method="post" action="${destination}/workspace/session"><input type="hidden" name="ticket" value="${ticket}"><noscript><button>Continue</button></noscript></form>
    <script nonce="${nonce}">document.forms[0].submit()</script></body></html>`;
  return new Response(await page, {headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'origin',
    'X-Frame-Options':'DENY','Content-Security-Policy':`default-src 'none'; base-uri 'none'; frame-ancestors 'none'; script-src 'nonce-${nonce}'; form-action ${destination}` }});
}

export async function acceptWorkspace(request: Request, env: Bindings, account: string) {
  const invalid = () => new Response('Login expired', {status:403,headers:{'Cache-Control':'no-store'}});
  const directory = new URL(request.url).origin === directoryOrigin && account === directoryOrigin;
  if (request.method !== 'POST' || request.headers.get('Origin') !== (directory ? directoryOrigin : env.PUBLIC_ORIGIN) ||
      !request.headers.get('Content-Type')?.startsWith('application/x-www-form-urlencoded')) return invalid();
  const reader = request.body?.getReader();
  if (!reader) return invalid();
  let text = '';
  const decoder = new TextDecoder();
  for (;;) {
    const {value, done} = await reader.read();
    if (done) break;
    if (text.length + value.length > 128) { await reader.cancel(); return invalid(); }
    text += decoder.decode(value);
  }
  const ticket = new URLSearchParams(text).get('ticket');
  if (directory && ticket === '') return new Response(null, {status:204, headers:{'Set-Cookie':cookieValue('',0)}});
  if (!ticket || !/^[\w-]{43}$/.test(ticket)) return invalid();
  const now = Date.now(), token = randomToken(), oldHash = await sha256(ticket);
  const row = await env.DB.prepare(`DELETE FROM workspace_sessions WHERE token_hash=? AND account_name=? AND next_path IS NOT NULL AND expires_at>?
    RETURNING next_path,session_hash`).bind(oldHash,account,now).first<{next_path:string;session_hash:string}>();
  if (!row) return invalid();
  if (directory && (await getSession(request, env))?.tokenHash === row.session_hash) return new Response(null, {status:204});
  const saved = await env.DB.prepare(`INSERT INTO workspace_sessions
    SELECT ?,s.token_hash,?,NULL,s.expires_at FROM sessions s WHERE s.token_hash=? AND s.expires_at>? RETURNING expires_at`)
    .bind(await sha256(token),account,row.session_hash,now).first<{expires_at:number}>();
  if (!saved) return invalid();
  return new Response(null,{status:directory ? 204 : 303,headers:{...(directory ? {} : {Location:row.next_path}),'Set-Cookie':cookieValue(token,Math.max(1,Math.floor((saved.expires_at-now)/1000))),
    'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
}
