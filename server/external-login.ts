import { validateAccountName } from './domain';
import { configuredOwnerId } from './account-names';
import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { createSession, enforceIpRate, getSession, requireCsrf, parseCookies, randomToken, requireOrigin, sha256 } from './security';
import { HttpError, type Bindings } from './types';

const providers = {
  tiktok: {
    authorize: 'https://www.tiktok.com/v2/auth/authorize/', token: 'https://open.tiktokapis.com/v2/oauth/token/',
  },
  chatgpt: {
    issuer: 'https://auth.openai.com', authorize: 'https://auth.openai.com/api/accounts/authorize',
    token: 'https://auth.openai.com/api/accounts/oauth/token', keys: createRemoteJWKSet(new URL('https://auth.openai.com/.well-known/jwks.json')),
  },
  google: {
    issuer: 'https://accounts.google.com', authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token', keys: createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs')),
  },
};
type Provider = keyof typeof providers;
function provider(value: string): Provider {
  if (value === 'google' || value === 'tiktok' || value === 'chatgpt') return value;
  throw new HttpError(404, 'NO_PROVIDER', 'この認証方法は利用できません。');
}
function credentials(env: Bindings, p: Provider) {
  if (p === 'tiktok' && env.TIKTOK_CLIENT_KEY && env.TIKTOK_CLIENT_SECRET)
    return { id: env.TIKTOK_CLIENT_KEY, secret: env.TIKTOK_CLIENT_SECRET };
  if (p === 'chatgpt' && env.CHATGPT_CLIENT_ID && env.CHATGPT_CLIENT_SECRET)
    return { id: env.CHATGPT_CLIENT_ID, secret: env.CHATGPT_CLIENT_SECRET };
  if (p === 'google' && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET)
    return { id: env.GOOGLE_CLIENT_ID, secret: env.GOOGLE_CLIENT_SECRET };
}
const cookieName = '__Host-a2aroom_oidc';
const flowCookie = (value: string, age: number) => `${cookieName}=${value}; Path=/; Max-Age=${age}; Secure; HttpOnly; SameSite=Lax`;
export const externalLogin = new Hono<{ Bindings: Bindings }>();

externalLogin.get('/providers', async c => {
  const session = await getSession(c.req.raw,c.env);
  const linked = session ? (await c.env.DB.prepare('SELECT provider FROM login_identities WHERE user_id=?').bind(session.user.id).all<{provider:string}>()).results : [];
  return c.json({providers: (['google','tiktok','chatgpt'] as const)
    .filter(p => credentials(c.env,p) && (p === 'google' || (c.env.PRIVATE_BETA !== 'true' && !session?.operator)))
    .map(id => ({id,enabled:true,linked:linked.some(row => row.provider === id)}))});
});

async function ownerEmail(env: Bindings, email: string | null) {
  return email !== null && await sha256(email) === env.OWNER_GOOGLE_EMAIL_HASH;
}

externalLogin.post('/:provider/start', async c => {
  requireOrigin(c.req.raw,c.env);
  const p = provider(c.req.param('provider')), config = credentials(c.env,p);
  if (!config) throw new HttpError(404,'NO_PROVIDER','この認証方法は現在利用できません。');
  await enforceIpRate(c.env,c.req.raw,'identity-start',30,600_000);
  const body = await c.req.json<{mode:string;next?:string}>();
  if (body.mode !== 'login' && body.mode !== 'link') throw new HttpError(400,'INVALID_MODE','認証方法を確認してください。');
  const session = body.mode === 'link' ? await getSession(c.req.raw,c.env) : null;
  if (body.mode === 'link') {
    if (!session || session.operator || p === 'google') throw new HttpError(403,'LINK_FORBIDDEN','このログイン方法を追加できません。');
    requireCsrf(c.req.raw,session);
  }
  if (p !== 'google' && c.env.PRIVATE_BETA === 'true') throw new HttpError(403,'PRIVATE_BETA','この認証方法は現在利用できません。');
  const state = randomToken(), browser = randomToken(), verifier = randomToken(48), nonce = randomToken();
  const next = typeof body.next === 'string' && body.next.length <= 8192 && /^(?:\/account\/profile$|\/authorize\?|\/(?:rooms|invite)\/[\w-]+(?:\?|$))/.test(body.next) ? body.next : '/inbox';
  await c.env.DB.prepare('INSERT INTO login_transactions VALUES(?,?,?,?,?,?,?,?,?)')
    .bind(await sha256(state),await sha256(browser),p,verifier,nonce,session?.user.id ?? null,session?.tokenHash ?? null,next,Date.now()+600_000).run();
  const url = new URL(providers[p].authorize);
  url.search = new URLSearchParams({response_type:'code', state, redirect_uri:c.env.PUBLIC_ORIGIN+'/api/external/'+p+'/callback'}).toString();
  if (p === 'tiktok') {
    url.searchParams.set('client_key',config.id);
    url.searchParams.set('scope','user.info.basic');
  } else {
    url.searchParams.set('client_id',config.id);
    url.searchParams.set('scope',p === 'google' ? 'openid email' : 'openid profile email');
    url.searchParams.set('nonce',nonce);
    url.searchParams.set('code_challenge_method','S256');
    url.searchParams.set('code_challenge',createHash('sha256').update(verifier).digest('base64url'));
  }
  if (p === 'google') url.searchParams.set('prompt','select_account');
  c.header('Set-Cookie',flowCookie(browser,600));
  return c.json({url:url.href});
});

type PendingRegistration = { subject: string; email: string | null; next_path: string };

async function confirmationKey(request: Request, id: string, p: Provider) {
  const cookie = parseCookies(request.headers.get('Cookie'))[cookieName];
  if (cookie?.length !== 43 || id.length !== 43) throw expiredConfirmation();
  return [id, await sha256(cookie), Date.now(), p] as const;
}

const liveConfirmation = 'id=? AND browser_hash=? AND expires_at>? AND provider=?';
function expiredConfirmation() {
  return new HttpError(410, 'CONFIRMATION_EXPIRED', '確認の有効期限が切れました。もう一度ログインしてください。');
}

externalLogin.get('/:provider/confirmation/:id', async c => {
  const p = provider(c.req.param('provider'));
  const key = await confirmationKey(c.req.raw, c.req.param('id'),p);
  const row = await c.env.DB.prepare(`SELECT email FROM google_login_confirmations WHERE ${liveConfirmation}`).bind(...key).first<{email:string|null}>();
  if (!row) throw expiredConfirmation();
  c.header('Cache-Control','no-store');
  const account = p === 'google' && await ownerEmail(c.env,row.email) ? c.env.OWNER_ACCOUNT : null;
  return c.json({ account });
});

externalLogin.post('/:provider/confirmation/:id/cancel', async c => {
  requireOrigin(c.req.raw,c.env);
  const p = provider(c.req.param('provider'));
  const key = await confirmationKey(c.req.raw, c.req.param('id'),p);
  const result = await c.env.DB.prepare(`DELETE FROM google_login_confirmations WHERE ${liveConfirmation}`).bind(...key).run();
  if (result.meta.changes) c.header('Set-Cookie',flowCookie('',0));
  return c.json({ok:true});
});

externalLogin.post('/:provider/confirmation/:id', async c => {
  requireOrigin(c.req.raw,c.env);
  const p = provider(c.req.param('provider'));
  const key = await confirmationKey(c.req.raw, c.req.param('id'),p);
  if (!credentials(c.env,p)) throw expiredConfirmation();
  const pending = await c.env.DB.prepare(`SELECT subject,email,next_path FROM google_login_confirmations WHERE ${liveConfirmation}`)
    .bind(...key).first<PendingRegistration>();
  if (!pending) throw expiredConfirmation();
  const account = validateAccountName((await c.req.json()).account);
  const owner = p === 'google' && await ownerEmail(c.env,pending.email);
  if (owner !== (account === c.env.OWNER_ACCOUNT) || (!owner && c.env.PRIVATE_BETA === 'true'))
    throw new HttpError(403,'RESERVED_ACCOUNT','このIDは選択できません。');
  const id = crypto.randomUUID();
  const now = Date.now();
  try {
    const [created] = await c.env.DB.batch([
      c.env.DB.prepare(`INSERT INTO users(id,account_name,email,created_at)
        SELECT ?,?,COALESCE(email,?),? FROM google_login_confirmations WHERE ${liveConfirmation}`)
        .bind(id,account,'no-email:'+id,now,...key),
      c.env.DB.prepare(`INSERT INTO login_identities(provider,subject,user_id)
        SELECT provider,subject,? FROM google_login_confirmations WHERE ${liveConfirmation}`)
        .bind(id,...key),
      c.env.DB.prepare(`DELETE FROM google_login_confirmations WHERE ${liveConfirmation}`).bind(...key),
    ]);
    if (!created.meta.changes) throw expiredConfirmation();
  } catch (error) {
    if (error instanceof Error && error.message.includes('UNIQUE constraint failed'))
      throw new HttpError(409,'ACCOUNT_EXISTS','このIDまたは外部アカウントは既に登録されています。');
    throw error;
  }
  c.header('Set-Cookie',flowCookie('',0));
  const login = await createSession(c.env,id);
  c.header('Set-Cookie',login.cookie,{append:true});
  return c.json({next:pending.next_path});
});

type Transaction = {verifier:string;nonce:string;link_user:string|null;session_hash:string|null;next_path:string};
externalLogin.get('/:provider/callback', async c => {
  const p = provider(c.req.param('provider')), config = credentials(c.env,p);
  const browser = parseCookies(c.req.header('Cookie') ?? null)[cookieName], state = c.req.query('state');
  const failure = (link = false) => c.redirect(link ? '/account/profile?external=failed' : '/?login=1&external=failed',303);
  if (!config || !state || state.length !== 43 || !browser) return failure();
  const tx = await c.env.DB.prepare('DELETE FROM login_transactions WHERE state_hash=? AND browser_hash=? AND provider=? AND expires_at>? RETURNING *')
    .bind(await sha256(state),await sha256(browser),p,Date.now()).first<Transaction>();
  if (!tx) return failure();
  c.header('Set-Cookie',flowCookie('',0));
  const code = c.req.query('code');
  if (!code || c.req.query('error')) return failure(Boolean(tx.link_user));

  const form = new URLSearchParams({client_id:config.id,code,grant_type:'authorization_code',code_verifier:tx.verifier,redirect_uri:c.env.PUBLIC_ORIGIN+'/api/external/'+p+'/callback'});
  const headers = new Headers();
  if (p === 'tiktok') {
    headers.set('Content-Type','application/x-www-form-urlencoded');
    form.delete('code_verifier');
    form.delete('client_id');
    form.set('client_key',config.id);
  }
  if (p === 'chatgpt') headers.set('Authorization','Basic '+btoa(config.id+':'+config.secret));
  else form.set('client_secret',config.secret);
  let subject: string;
  let email: string | null = null;
  try {
    const response = await fetch(providers[p].token,{method:'POST',body:form,headers,redirect:'manual',signal:AbortSignal.timeout(10000)});
    if (!response.ok) return failure(Boolean(tx.link_user));
    const tokens = await response.json() as {id_token?:string; open_id?:string; access_token?:string; error?:string};
    if (p === 'tiktok') {
      if (tokens.error || !tokens.access_token || typeof tokens.open_id !== 'string' || !tokens.open_id || tokens.open_id.length > 255) return failure();
      subject = tokens.open_id;
    } else {
      const idp = providers[p];
      const token = tokens.id_token;
      if (!token) return failure(Boolean(tx.link_user));
      const {payload} = await jwtVerify(token,idp.keys,{issuer:idp.issuer,audience:config.id,algorithms:['RS256'],requiredClaims:['sub','iat','exp','nonce'],maxTokenAge:'10m',clockTolerance:5});
      if (payload.nonce !== tx.nonce || typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 255 ||
        ((payload.azp !== undefined || (Array.isArray(payload.aud) && payload.aud.length > 1)) && payload.azp !== config.id)) return failure(Boolean(tx.link_user));
      if (p === 'google') {
        if (payload.email_verified !== true || typeof payload.email !== 'string' || payload.email.length > 254 ||
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) return failure();
        email = payload.email.toLowerCase();
      }
      subject = payload.sub;
    }
  } catch (error) { console.warn('external_identity_verification_failed',p,error instanceof Error ? error.name : 'unknown'); return failure(Boolean(tx.link_user)); }
  // These subjects are scoped to the provider's registered app. Preserve existing Google keys.
  if (p !== 'google') subject = JSON.stringify([config.id, subject]);
  if (p !== 'google' && c.env.PRIVATE_BETA === 'true') return failure();
  if (tx.link_user) {
    const session = await getSession(c.req.raw,c.env);
    if (!session || session.operator || session.user.id !== tx.link_user || session.tokenHash !== tx.session_hash) return failure(true);
    await c.env.DB.prepare('INSERT INTO login_identities(provider,subject,user_id) VALUES(?,?,?) ON CONFLICT DO NOTHING')
      .bind(p,subject,session.user.id).run();
    const linked = await c.env.DB.prepare('SELECT 1 FROM login_identities WHERE provider=? AND subject=? AND user_id=?')
      .bind(p,subject,session.user.id).first();
    return linked ? c.redirect('/account/profile?external=linked',303) : failure(true);
  }
  const user = await c.env.DB.prepare(`SELECT u.id FROM users u JOIN login_identities i ON u.id=i.user_id WHERE i.provider=? AND i.subject=? AND u.is_guest=0 AND (? <> 'true' OR u.id=${configuredOwnerId})`)
    .bind(p,subject,c.env.PRIVATE_BETA,c.env.OWNER_ACCOUNT).first<{id:string}>();
  if (!user) {
    if (p === 'google' && (!email || !c.env.OWNER_GOOGLE_EMAIL_HASH || (c.env.PRIVATE_BETA === 'true' && !await ownerEmail(c.env,email)))) return failure();
    const id = randomToken(), cookie = randomToken();
    await c.env.DB.prepare('INSERT INTO google_login_confirmations(id,browser_hash,subject,email,next_path,expires_at,provider) VALUES(?,?,?,?,?,?,?)')
      .bind(id,await sha256(cookie),subject,email,tx.next_path,Date.now()+600_000,p).run();
    c.header('Set-Cookie',flowCookie(cookie,600));
    return c.redirect('/?login=1&'+p+'_link='+id,303);
  }
  const login = await createSession(c.env,user.id);
  c.header('Set-Cookie',login.cookie,{append:true});
  return c.redirect(tx.next_path,303);
});
