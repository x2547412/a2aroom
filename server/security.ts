import { configuredOwnerId } from './account-names';
import { directoryOrigin, directoryAppOrigin, directoryAvatarPath, directorySessionPath } from '../shared/directory';
import { isDirectoryHost, publicAccessEnabled } from './public-access';
import type { Bindings, Session } from './types';
import { HttpError } from './types';

const encoder = new TextEncoder();
const SESSION_COOKIE = '__Host-a2aroom_session';
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;

export function contentSecurityPolicy({ formOrigin, directoryHome = false }: { formOrigin?: string; directoryHome?: boolean } = {}): string {
  // Redirect origins come from registered OAuth clients. Reject CSP metacharacters
  // even if a URL parser accepts them as part of a hostname.
  if (formOrigin !== undefined && !/^https?:\/\/(?:[a-z0-9.-]+|\[[a-f0-9:.]+\])(?::\d{1,5})?$/i.test(formOrigin)) {
    throw new HttpError(400, 'INVALID_REDIRECT', '認可先の形式を確認できません。');
  }
  const avatarSource = directoryHome ? ` ${directoryAppOrigin}${directoryAvatarPath} ${directoryAppOrigin}/api/images/user/ ${directoryAppOrigin}/api/images/agent/` : '';
  const sessionSource = directoryHome ? ` ${directoryAppOrigin}${directorySessionPath} ${directoryAppOrigin}/api/rooms` : '';
  return `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:${avatarSource}; media-src 'self' blob:; connect-src 'self'${sessionSource}; base-uri 'none'; frame-ancestors 'none'; form-action 'self'${formOrigin ? ` ${formOrigin}` : ''}`;
}

export function randomToken(bytes = 32): string {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...data)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function constantTimeEqual(a: string, b: string): boolean {
  const aa = encoder.encode(a);
  const bb = encoder.encode(b);
  let mismatch = aa.length ^ bb.length;
  const length = Math.max(aa.length, bb.length);
  for (let i = 0; i < length; i++) mismatch |= (aa[i] ?? 0) ^ (bb[i] ?? 0);
  return mismatch === 0;
}

export function parseCookies(header: string | null): Record<string, string> {
  return Object.fromEntries((header ?? '').split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const index = part.indexOf('=');
    return index < 0 ? [part, ''] : [part.slice(0, index), part.slice(index + 1)];
  }));
}

export function cookieValue(token: string, maxAge: number): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export async function createSession(env: Bindings, userId: string): Promise<{ cookie: string; csrf: string }> {
  const token = randomToken();
  const csrf = randomToken();
  const now = Date.now();
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(await sha256(token), userId, csrf, now + SESSION_MS, now).run();
  return { cookie: cookieValue(token, SESSION_MS / 1000), csrf };
}

export async function getSession(request: Request, env: Bindings): Promise<Session | null> {
  const token = parseCookies(request.headers.get('Cookie'))[SESSION_COOKIE];
  if (!token) return null;
  const workspace = env.ENVIRONMENT === 'production' && new URL(request.url).origin !== env.PUBLIC_ORIGIN;
  const url = new URL(request.url);
  const directory = isDirectoryHost(url,env);
  const account = directory ? directoryOrigin : url.hostname.split('.')[0];
  const row = await env.DB.prepare(`SELECT u.id, u.account_name, u.display_name, u.bio, u.bio_public, u.email, (u.id IS ${configuredOwnerId}) AS operator, s.csrf_token, s.token_hash
    FROM sessions s JOIN users u ON u.id = s.user_id
    ${workspace ? `JOIN workspace_sessions w ON w.session_hash=s.token_hash ${directory ? '' : 'AND w.account_name=u.account_name'}` : ''}
    WHERE ${workspace ? 'w.token_hash=? AND w.next_path IS NULL AND w.account_name=?' : 's.token_hash=?'}
      AND s.expires_at > ? AND u.is_guest = 0`)
    .bind(env.OWNER_ACCOUNT, await sha256(token), ...(workspace ? [account] : []), Date.now()).first<{ operator: number; id: string; account_name: string; display_name: string | null; bio: string | null; bio_public: number; email: string; csrf_token: string; token_hash: string }>();
  if (!row) return null;
  if (env.PRIVATE_BETA === 'true' && !row.operator) return null;
  return { operator: Boolean(row.operator), user: { id: row.id, account_name: row.account_name, display_name: row.display_name, bio: row.bio, bio_public: Boolean(row.bio_public), email: row.email.startsWith('no-email:') ? '' : row.email }, csrf: row.csrf_token, tokenHash: row.token_hash };
}

export async function deleteSession(request: Request, env: Bindings): Promise<string> {
  const session = await getSession(request, env);
  if (session) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(session.tokenHash).run();
  return cookieValue('', 0);
}

export function requireOrigin(request: Request, env: Bindings): void {
  const origin = request.headers.get('Origin');
  const expected = new URL(request.url).origin;
  if (!origin || (origin !== expected && !(env.ENVIRONMENT === 'development' && origin === env.DEV_ORIGIN))) {
    throw new HttpError(403, 'BAD_ORIGIN', 'この操作は許可されていません。');
  }
}

export function requireCsrf(request: Request, session: Session): void {
  const supplied = request.headers.get('X-CSRF-Token') ?? '';
  if (!supplied || !constantTimeEqual(supplied, session.csrf)) throw new HttpError(403, 'BAD_CSRF', 'セッションを更新してからやり直してください。');
}

export function validateHost(request: Request, env: Bindings): void {
  const host = new URL(request.url).hostname.toLowerCase();
  if (env.ENVIRONMENT === 'development') {
    if (!['localhost', '127.0.0.1', '::1'].includes(host)) throw new HttpError(503, 'DEVELOPMENT_HOST', '開発用設定ではこのホストを使用できません。');
    return;
  }
  if (env.ENVIRONMENT !== 'production') throw new HttpError(503, 'INVALID_ENVIRONMENT', '環境設定を確認してください。');
  if ((env.PRIVATE_BETA !== 'true' && !publicAccessEnabled(env)) || !env.OWNER_ACCOUNT || new URL(env.PUBLIC_ORIGIN).protocol !== 'https:') {
    throw new HttpError(503, 'PRIVATE_BETA_CONFIG', '本人限定の設定を確認してください。');
  }
  const configured = new URL(env.PUBLIC_ORIGIN).hostname.toLowerCase();
  if (host !== configured && !isDirectoryHost(new URL(request.url),env)) throw new HttpError(404, 'NOT_FOUND', 'ページが見つかりません。');
}

export function requireSecureTransport(request: Request, env: Bindings): Response | null {
  const url = new URL(request.url);
  if (env.ENVIRONMENT !== 'production' || url.protocol === 'https:') return null;
  if (request.method === 'GET' || request.method === 'HEAD') {
    url.protocol = 'https:';
    return Response.redirect(url.toString(), 308);
  }
  return Response.json({ error: 'HTTPS_REQUIRED' }, { status: 403 });
}

export async function enforceIpRate(env: Bindings, request: Request, bucket: string, limit: number, windowMs: number): Promise<void> {
  const ip = request.headers.get('CF-Connecting-IP') || (env.ENVIRONMENT === 'development' ? 'local' : 'unknown');
  const key = await sha256(`${bucket}:${ip}`);
  const now = Date.now();
  const result = await env.DB.prepare(`INSERT INTO login_attempts (subject_hash, created_at)
    SELECT ?, ? WHERE (SELECT COUNT(*) FROM login_attempts WHERE subject_hash = ? AND created_at > ?) < ?`)
    .bind(key, now, key, now - windowMs, limit).run();
  if (!result.meta.changes) throw new HttpError(429, 'LOGIN_RATE_LIMIT', 'しばらく待ってから再度お試しください。');
}
