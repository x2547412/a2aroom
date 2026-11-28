import { mcpBodyLimit } from './agent-media-tools';
import { issueWorkspaceTicket, workspacePage, enterWorkspace, acceptWorkspace, moveTo } from './workspace';
import { publicAccountPage } from './account-pages';
import { configuredOwnerId } from './account-names';
import { cleanupMedia } from './chat-media';
import { cleanupRateLimits } from './rate-limit-cleanup';
import { cleanupExpiredHumanGuests } from './guest-cleanup';
import { maxUploadBody } from '../shared/chat';
import { directoryOrigin, directoryAppOrigin, directoryAvatarPath, directorySessionPath, publicRoomsUrl } from '../shared/directory';
export { DirectoryHub } from './directory-hub';
import { directoryAsset, site } from './site-pages';
import { isDirectoryHost, isDirectoryDeployment, publicAccessEnabled, stagingOrigin } from './public-access';
export { PushHub } from './push-hub';
import { repairWakes } from './wakes';
import { Hono, type ErrorHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import OAuthProvider, { OAuthError } from '@cloudflare/workers-oauth-provider';
import type { OAuthResourceContext } from '@cloudflare/workers-oauth-provider';
import type { Bindings, OAuthProps } from './types';
import { HttpError } from './types';
import { externalLogin } from './external-login';
import { api } from './api';
import { authorize } from './oauth';
import { contentSecurityPolicy, enforceIpRate, getSession, requireSecureTransport, sha256, validateHost } from './security';
import { handleMcp, mcpErrorMessage } from './mcp';
import { checkAgentConnection } from './store';
import { agentDiscovery } from './agent-discovery';
import { agentGuidePage, readAgentGuide } from './agent-guide';
import { requestPages } from './request-pages';
import { publicApi } from './public';

const app = new Hono<{ Bindings: Bindings }>();
const handleError: ErrorHandler<{Bindings: Bindings}> = (error,c) => {
  if (error instanceof HttpError) return c.json({ error: error.code, message: error.message }, error.status as 400);
  console.error('request_failed', error instanceof Error ? error.name : 'unknown');
  return c.json({ error: 'INTERNAL_ERROR', message: '処理できませんでした。時間をおいてお試しください。' }, 500);
};
app.onError(handleError);
function requestLimit(path:string,method:string) {
  if (method === 'POST' && /^\/(?:mcp|api\/public\/(?:rooms\/[^/]+\/)?mcp)\/?$/.test(path)) return mcpBodyLimit;
  return method === 'POST' && /^\/api\/(?:public\/)?rooms\/[^/]+\/media-messages$/.test(path) ? maxUploadBody : 65_536;
}
const rootSite = new Hono<{ Bindings: Bindings }>();
rootSite.onError(handleError);
for (const router of [app, rootSite]) {
  router.route('/', agentDiscovery);
  router.route('/', requestPages);
  router.use('/api/*', (c,next) => bodyLimit({
    maxSize: requestLimit(c.req.path,c.req.method),
    onError: ctx => ctx.json({ error: 'BODY_TOO_LARGE', message: '送信サイズの上限を超えています。' }, 413),
  })(c,next));
}
rootSite.use('/api/public/*', async (c,next) => {
  if (!c.req.path.startsWith('/api/public/rooms') || /\/mcp\/?$/.test(c.req.path)) return c.notFound();
  await next();
});
rootSite.route('/api/public',publicApi);
rootSite.route('/',site);
rootSite.get('/.well-known/mcp-registry-auth', c => c.text('v=MCPv1; k=ed25519; p=AU8PSQQMpzg+oTpdUOfou1IM85OMvcrojFREGPjEnms='));
rootSite.get('/tiktok9oVUngz5JHk6K8Ic8sOYCYK2GVLxAAMm.txt', c => c.text("tiktok-developers-site-verification=9oVUngz5JHk6K8Ic8sOYCYK2GVLxAAMm"));
for (const path of ['/agent/guide','/agent-skill/SKILL.md','/llms.txt']) {
  rootSite.get(path, c => c.redirect(c.env.PUBLIC_ORIGIN + path, 308));
}
for (const path of ['/directory', '/directory/', '/explore', '/explore/']) rootSite.get(path, c => redirectDirectory(c.req.url));
// Serve the browser workspace on the directory origin using its own host-only cookie.
rootSite.use('/api/*', async (c,next) => publicAccessEnabled(c.env) ? next() : c.notFound());
rootSite.post('/api/workspace/session', c => acceptWorkspace(c.req.raw,c.env,directoryOrigin));
rootSite.use('/api/external/*', async (c,next) => c.req.path === '/api/external/providers' && c.req.method === 'GET' ? next() : c.notFound());
rootSite.route('/api/external', externalLogin);
rootSite.route('/api', api);
rootSite.get('*', (c,next) => publicAccessEnabled(c.env) && workspacePage.test(c.req.path)
  ? c.env.ASSETS.fetch(new URL('/', c.req.url)) : next());
for (const router of [app, rootSite]) router.get('/agent/skill-download', async (c) => new Response(await readAgentGuide(c.env), {
  headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': 'attachment; filename="SKILL.md"' },
}));
rootSite.all('*',async c => (c.req.method === 'GET' || c.req.method === 'HEAD') && directoryAsset(c.req.path)
  ? c.env.ASSETS.fetch(c.req.raw) : c.text('ページが見つかりません。',404));
function redirectDirectory(requestUrl: string) {
  const url = new URL(requestUrl);
  return Response.redirect(publicRoomsUrl(url.origin, url.search), 302);
}
app.route('/',site);
for (const path of ['/directory', '/directory/', '/explore/']) app.get(path, c => redirectDirectory(c.req.url));
app.get('/explore', c => new URL(c.req.url).origin === directoryAppOrigin
  ? redirectDirectory(c.req.url) : c.env.ASSETS.fetch(c.req.raw));
// Only these GET responses can be read by the first-party directory.
for (const path of [directorySessionPath, directoryAvatarPath, '/api/rooms', '/api/images/user/:id', '/api/images/agent/:id']) app.use(path, async (c,next) => {
  if (c.req.method !== 'GET') return next();
  c.header('Vary', 'Origin');
  const origin = c.req.header('Origin');
  if (origin && origin !== new URL(c.req.url).origin) {
    if (origin !== directoryOrigin || !isDirectoryHost(new URL(origin), c.env)) {
      return c.json({ error: 'BAD_ORIGIN' }, 403);
    }
    c.header('Access-Control-Allow-Origin', directoryOrigin);
    c.header('Access-Control-Allow-Credentials', 'true');
  }
  await next();
});
app.post(directorySessionPath, async c => {
  if (!publicAccessEnabled(c.env) || new URL(c.req.url).origin !== directoryAppOrigin ||
      c.req.header('Origin') !== directoryOrigin || !isDirectoryDeployment(c.env)) return c.notFound();
  c.header('Access-Control-Allow-Origin', directoryOrigin);
  c.header('Access-Control-Allow-Credentials', 'true');
  c.header('Vary', 'Origin');
  const session = await getSession(c.req.raw, c.env);
  return c.json({ ticket: session ? await issueWorkspaceTicket(c.env, session, directoryOrigin, '/') : '' });
});
app.get(directorySessionPath, async (c) => {
  return c.json({ authenticated: Boolean(await getSession(c.req.raw, c.env)) });
});
// A first visit to a personal host may precede the workspace cookie handoff.
app.get('/api/workspace/owner', async c => {
  if (!isDirectoryDeployment(c.env) || !publicAccessEnabled(c.env) || new URL(c.req.url).origin !== directoryAppOrigin) return c.notFound();
  const origin = c.req.header('Origin') ?? '';
  const account = /^https:\/\/([a-z0-9-]{3,32})\.a2aroom\.com$/.exec(origin)?.[1];
  if (!account || origin === directoryAppOrigin || account === 'staging') return c.body(null, 403);
  const session = await getSession(c.req.raw, c.env);
  c.header('Access-Control-Allow-Origin', origin);
  c.header('Access-Control-Allow-Credentials', 'true');
  c.header('Vary', 'Origin');
  return c.json({ owner: session?.user.account_name === account });
});
app.route('/api/public', publicApi);
app.route('/api/external', externalLogin);
app.route('/api', api);
app.get('/agent-skill/guide.ja.md', c => c.redirect(c.env.PUBLIC_ORIGIN + '/agent-skill/SKILL.md', 308));
app.get('/agent/guide', (c) => agentGuidePage(c.env, c.req.header('Accept-Language') ?? '', c.req.header('Cookie')));

app.all('/authorize', (c) => authorize(c.req.raw, c.env));
app.all('/mcp', (c) => c.json({ error: 'AUTH_REQUIRED' }, 401));
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

function createProvider(origin: string): OAuthProvider<Bindings> {
  const resource = `${origin}/mcp`;
  return new OAuthProvider<Bindings>({
    apiRoute: '/mcp',
    apiHandler: {
      async fetch(request, env, context) {
        const ctx = context as OAuthResourceContext<OAuthProps>;
        if (!ctx.props || (ctx.props.authKind !== 'token' && !ctx.auth.scope.includes('rooms'))) {
          return Response.json({ error: 'insufficient_scope' }, { status: 403 });
        }
        try { return await handleMcp(request, env, ctx.props, ctx, ctx.auth.expiresAt); }
        catch (error) {
          if (error instanceof HttpError) return Response.json({ error: error.code, message: mcpErrorMessage(error) }, { status: error.status });
          console.error('mcp_failed', error instanceof Error ? error.name : 'unknown');
          return Response.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
        }
      },
    },
    defaultHandler: { fetch: (request, env, ctx) => app.fetch(request, env, ctx) },
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/oauth/token',
    clientRegistrationEndpoint: '/oauth/register',
    scopesSupported: ['rooms', 'offline_access'],
    requiredScopes: ['rooms'],
    clientIdMetadataDocumentEnabled: true,
    resourceMetadata: { resource, authorization_servers: [origin], resource_name: 'A2A Room' },
    async tokenExchangeCallback({ props, env }) {
      const identity = props as OAuthProps;
      try { await checkAgentConnection(env, identity.agentId, identity.connectionId, identity.userId); }
      catch (error) {
        if (error instanceof HttpError && error.status === 401) throw new OAuthError('invalid_grant', { description: 'The connection was revoked.' });
        throw error;
      }
    },
    async resolveExternalToken({ token, env }) {
      if (!token.startsWith('a2a_')) return null;
      const connection = await env.DB.prepare(`SELECT c.id AS connection_id, a.id AS agent_id, a.owner_id, u.account_name
        FROM agent_connections c JOIN agents a ON a.id = c.agent_id JOIN users u ON u.id = a.owner_id
        WHERE c.token_hash = ? AND c.kind = 'token' AND c.revoked_at IS NULL AND a.deleted_at IS NULL AND (? <> 'true' OR a.owner_id=${configuredOwnerId})`)
        .bind(await sha256(token), env.PRIVATE_BETA, env.OWNER_ACCOUNT).first<{ connection_id: string; agent_id: string; owner_id: string; account_name: string }>();
      if (!connection) return null;
      return { props: { userId: connection.owner_id, agentId: connection.agent_id, connectionId: connection.connection_id, authKind: 'token' }, audience: resource };
    },
  });
}

export default {
  async fetch(request: Request, env: Bindings, ctx: ExecutionContext): Promise<Response> {
    const incoming = new URL(request.url);
    const publicMode = publicAccessEnabled(env);
    const account = /^([a-z0-9-]{3,32})\.a2aroom\.com$/.exec(incoming.hostname)?.[1];
    const loginFlow = incoming.origin === env.PUBLIC_ORIGIN && incoming.pathname === '/' &&
      (incoming.searchParams.get('login') === '1' || incoming.searchParams.has('next') || incoming.searchParams.has('google_link'));
    if (publicMode && isDirectoryDeployment(env) && account && incoming.origin !== env.PUBLIC_ORIGIN && incoming.protocol === 'https:' && !incoming.port &&
        ['GET','HEAD'].includes(request.method) && /^\/(?:rooms\/?)?$/.test(incoming.pathname) && !loginFlow) {
      return publicAccountPage(request, env, account);
    }
    const productionBrowser = publicMode && isDirectoryDeployment(env) && env.ENVIRONMENT === 'production' && incoming.protocol === 'https:' && !incoming.port;
    const personalHost = productionBrowser && account && incoming.origin !== env.PUBLIC_ORIGIN && account !== 'staging';
    const inboxPage = /^\/inbox\/?$/.test(incoming.pathname) && ['GET','HEAD'].includes(request.method);
    const legacyExplore = (inboxPage && incoming.searchParams.get('tab') === 'public') ||
      (/^\/account\/explore\/?$/.test(incoming.pathname) && ['GET','HEAD'].includes(request.method));
    if (legacyExplore && incoming.origin === env.PUBLIC_ORIGIN) return redirectDirectory(request.url);
    const pageRequest = request.method === 'GET' && workspacePage.test(incoming.pathname);
    let personalApp = false;
    if (productionBrowser && incoming.origin === env.PUBLIC_ORIGIN && (pageRequest || (request.method === 'GET' && loginFlow)) &&
        !(incoming.pathname === '/account/profile' && incoming.searchParams.get('manage_login') === '1') &&
        !incoming.searchParams.has('next') && !['google_link','chatgpt_link','tiktok_link'].some(key => incoming.searchParams.has(key))) {
      const session = await getSession(request,env);
      if (session && session.user.account_name !== account) {
        return enterWorkspace(env,session,pageRequest ? incoming.pathname + incoming.search : '/inbox');
      }
    }
    if (personalHost && inboxPage && !legacyExplore) {
      const session = await getSession(request, env);
      if (session?.user.account_name !== account) return publicAccountPage(request, env, account);
    }
    if (personalHost) {
      if (incoming.pathname === '/api/public/mcp' || /^\/api\/public\/rooms\/[^/]+\/mcp\/?$/.test(incoming.pathname)) return new Response('Use the MCP host', {status:404});
      if (incoming.pathname === '/workspace/session') return acceptWorkspace(request,env,account);
      if (legacyExplore || inboxPage || pageRequest || /^\/requests(?:\/[^/]+)?$/.test(incoming.pathname) || incoming.pathname.startsWith('/api/') || directoryAsset(incoming.pathname) ||
          ['/terms','/privacy','/guidelines','/contact','/contact/received','/agent/guide','/agent/skill-download'].includes(incoming.pathname)) {
        const registered = await env.DB.prepare('SELECT 1 FROM users WHERE account_name=? AND is_guest=0').bind(account).first();
        if (!registered) return new Response('Not found',{status:404});
        if (legacyExplore) return redirectDirectory(request.url);
        if (pageRequest && !inboxPage && !(await getSession(request,env))) {
          const target = new URL(incoming.pathname + incoming.search,env.PUBLIC_ORIGIN);
          return moveTo(target);
        } else {
          if (incoming.pathname.startsWith('/api/external/') && incoming.pathname !== '/api/external/providers')
            return new Response('Use the sign-in host',{status:403});
          personalApp = true;
        }
      }
    }
    if (!personalApp && env.ENVIRONMENT === 'production' && env.OWNER_ACCOUNT && (env.PRIVATE_BETA === 'true' || publicMode)
        && (isDirectoryDeployment(env) || (publicMode && env.PUBLIC_ORIGIN === stagingOrigin))
        && incoming.hostname !== new URL(env.PUBLIC_ORIGIN).hostname) {
      const alias = /^([a-z0-9-]{3,32})\.a2aroom\.com$/.exec(incoming.hostname)?.[1];
      if (alias && incoming.protocol === 'https:' && !incoming.port && ['GET','HEAD'].includes(request.method)
          && /^\/(?:rooms\/[a-zA-Z0-9-]+)?$/.test(incoming.pathname)) {
        const roomId = incoming.pathname.split('/')[2] ?? null;
        const claimed = await env.DB.prepare(`SELECT 1 FROM users u WHERE u.account_name=? AND u.is_guest=0
          AND (?='true' OR u.id=${configuredOwnerId})
          AND (? IS NULL OR EXISTS (SELECT 1 FROM rooms r WHERE r.id=? AND r.host_user_id=u.id))`)
          .bind(alias, String(publicMode), env.OWNER_ACCOUNT, roomId, roomId).first();
        if (claimed) {
          const target = new URL(incoming.pathname, env.PUBLIC_ORIGIN);
          const tag = incoming.searchParams.get('tag');
          if (roomId && tag) target.searchParams.set('tag', tag);
          if (incoming.searchParams.get('login') === '1') target.searchParams.set('login', '1');
          return new Response(null, { status: 302, headers: { Location: target.href, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
        }
      }
    }
    try { if (!personalApp) validateHost(request, env); }
    catch (error) {
      if (error instanceof HttpError) return Response.json({ error: error.code }, { status: error.status });
      throw error;
    }
    const insecureResponse = requireSecureTransport(request, env);
    if (insecureResponse) return insecureResponse;
    const url = new URL(request.url);
    const path = url.pathname;
    const length = Number(request.headers.get('content-length') ?? 0);
    if (length > (requestLimit(path,request.method))) return Response.json({ error: 'BODY_TOO_LARGE' }, { status: 413 });
    if (request.method === 'POST' && (path === '/oauth/register' || path === '/oauth/token')) {
      try { await enforceIpRate(env, request, path, path === '/oauth/register' ? 20 : 120, 60 * 60_000); }
      catch (error) {
        if (error instanceof HttpError) return Response.json({ error: 'rate_limited' }, { status: 429 });
        throw error;
      }
    }
    const directory = isDirectoryHost(url, env);
    const response = directory
      ? await rootSite.fetch(request,env,ctx)
      : personalApp ? await app.fetch(request, env, ctx) : await createProvider(env.PUBLIC_ORIGIN).fetch(request, env, ctx);
    if (response.webSocket) return response;
    const headers = new Headers(response.headers);
    headers.set('X-Content-Type-Options', 'nosniff');
    const consentPage = path === '/authorize' && request.method === 'GET' && response.status === 200 && response.headers.get('Referrer-Policy') === 'same-origin';
    const directoryHome = directory && (path === '/' || path === '/explore' || workspacePage.test(path)) && (request.method === 'GET' || request.method === 'HEAD');
    headers.set('Referrer-Policy', consentPage || path === '/contact' ? 'same-origin' : 'no-referrer');
    headers.set('X-Frame-Options', 'DENY');
    if (env.ENVIRONMENT === 'production') headers.set('Strict-Transport-Security', 'max-age=31536000');
    headers.set('Content-Security-Policy', consentPage ? response.headers.get('Content-Security-Policy') ?? contentSecurityPolicy() : contentSecurityPolicy({ directoryHome }));
    if (pageRequest || inboxPage || loginFlow || path.startsWith('/api/') || path.startsWith('/oauth/')) headers.set('Cache-Control', 'no-store');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
  async scheduled(event: ScheduledController, env: Bindings, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(cleanupMedia(env));
    ctx.waitUntil(cleanupRateLimits(env, event.scheduledTime));
    ctx.waitUntil(cleanupExpiredHumanGuests(env, event.scheduledTime));
    ctx.waitUntil(env.DB.batch([
      env.DB.prepare(`DELETE FROM guest_sessions WHERE csrf_token IN ('mcp-joined','mcp-pending','mcp-lobby-joined','mcp-handle') AND expires_at<=?`).bind(event.scheduledTime),
      env.DB.prepare(`DELETE FROM users WHERE is_guest=1 AND account_name GLOB 'guest-ai-*'
        AND NOT EXISTS (SELECT 1 FROM guest_sessions WHERE user_id=users.id)
        AND NOT EXISTS (SELECT 1 FROM agents WHERE owner_id=users.id)`),
    ]));
    ctx.waitUntil(env.DB.batch(['login_transactions','google_login_confirmations','workspace_sessions','guest_room_requests'].map(table => env.DB.prepare(`DELETE FROM ${table} WHERE expires_at<=?`).bind(event.scheduledTime))));
    ctx.waitUntil(env.DB.prepare('DELETE FROM site_inquiries WHERE handled_at < ?').bind(event.scheduledTime - 90 * 86400_000).run());
    ctx.waitUntil(repairWakes(env, event.scheduledTime));
  },
} satisfies ExportedHandler<Bindings>;
