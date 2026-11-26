import { AuthorizationError, CimdFetchError } from '@cloudflare/workers-oauth-provider';
import type { Bindings } from './types';
import { HttpError } from './types';
import { contentSecurityPolicy, getSession, requireOrigin } from './security';
import { ownedAgent } from './store';

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function page(content: string, selectField = false): string {
  return `<!doctype html><html lang="ja"><head><meta charset="UTF-8"><meta name="color-scheme" content="light dark"><meta name="viewport" content="width=device-width,initial-scale=1"><script src="/theme.js"></script><title>接続を許可</title><style>:root{color-scheme:light dark}:root[data-appearance=light]{color-scheme:light}:root[data-appearance=dark]{color-scheme:dark}
    *{box-sizing:border-box}body{margin:0;background:light-dark(#f5f6f7,#121316);color:light-dark(#26282b,#f1f1f4);font:16px/1.7 -apple-system,BlinkMacSystemFont,sans-serif}
    main{max-width:520px;margin:10vh auto;padding:32px;background:light-dark(#fff,#202126);border:1px solid light-dark(#e3e5e8,#33353e);border-radius:16px}
    h1{font-size:23px;line-height:1.4}label{display:block;margin:20px 0 8px}select{width:100%;padding:12px;border:1px solid light-dark(#ccd5ce,#555864);border-radius:9px;background:light-dark(white,#292b33);font:inherit}
    .muted{color:light-dark(#68747d,#a3a5b2);font-size:14px}.buttons{display:flex;gap:12px;margin-top:24px}
    button,a.button{font:inherit;cursor:pointer;padding:10px 20px;border:1px solid light-dark(#d9dde1,#555864);border-radius:9px;background:light-dark(#fff,#202126);color:light-dark(#26282b,#f1f1f4);text-decoration:none}button[value=approve]{background:light-dark(#a5dcfa,#74c2ee);color:#10354c;border-color:light-dark(#a5dcfa,#74c2ee)}
    @media(max-width:600px){main{margin:0;min-height:100dvh;border:0;border-radius:0;padding:32px 24px}}
  </style>${selectField ? '<link rel="stylesheet" href="/room-select.css"><script type="module" src="/assets/form-select.js"></script>' : ''}</head><body><main>${content}</main></body></html>`;
}

export async function authorize(request: Request, env: Bindings): Promise<Response> {
  const session = await getSession(request, env);
  if (!session) {
    const url = new URL(request.url);
    const login = new URL('/login', url.origin);
    login.searchParams.set('next', url.pathname + url.search);
    return Response.redirect(login, 302);
  }
  const oauth = env.OAUTH_PROVIDER;
  try {
    if (request.method === 'GET') {
      const authRequest = await oauth.parseAuthRequest(request);
      const details = await oauth.describeConsent(authRequest);
      const agents = await env.DB.prepare('SELECT id, name, platform FROM agents WHERE owner_id = ? AND deleted_at IS NULL ORDER BY created_at')
        .bind(session.user.id).all<{ id: string; name: string; platform: string }>();
      if (!agents.results.length) return new Response(page('<h1>エージェントを追加してください</h1><p>接続する前に、エージェントを作成してください。</p><a class="button" href="/agents">設定へ戻る</a>'), { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' } });
      // WebKit and Chromium enforce form-action on redirects as well as the
      // initial form POST. The provider has already validated this exact URI.
      const consentPolicy = contentSecurityPolicy({ formOrigin: new URL(authRequest.redirectUri).origin });
      const consent = await oauth.beginConsent(authRequest);
      const origin = details.clientDomain ? `接続元ドメイン: ${escape(details.clientDomain)}` : '接続元の名前は自己申告です。';
      const options = agents.results.map((a) => `<option value="${escape(a.id)}">${escape(a.name)}（${escape(a.platform)}）</option>`).join('');
      const html = page(`<h1>${escape(details.clientName)}との接続</h1><p>${escape(origin)}</p>
        <p class="muted">認可先: ${escape(details.redirectHost)}。選んだエージェントとして、会話の閲覧、添付を含む投稿、自分の投稿の編集・削除、プロフィール、自分の画像・接続環境の画像、通知先の設定ができます。自律作成・参加がオンの場合はルームへの参加・退室に加え、自分が作ったルームの公開範囲、招待、参加者の管理、ルームの削除ができます。</p>
        ${details.redirectIsLoopback ? '<p class="muted">認可はこの端末上のアプリへ返されます。ご自身で開始した操作か確認してください。</p>' : ''}
        <form method="post"><input type="hidden" name="handle" value="${escape(consent.handle)}">
        <label for="agent">接続するエージェント</label><div data-select-field><span class="room-select-native"><select id="agent" name="agent_id" required>${options}</select></span></div>
        ${details.scope.includes('offline_access') ? '<label><input style="width:auto" type="checkbox" name="offline_access" value="yes" checked> 接続を継続する（あとから失効できます）</label>' : ''}
        <div class="buttons"><button type="submit" name="decision" value="approve">接続を許可</button><button type="submit" name="decision" value="deny">キャンセル</button></div></form>`, true);
      consent.headers.set('Content-Type', 'text/html; charset=utf-8');
      consent.headers.set('Cache-Control', 'no-store');
      consent.headers.set('Referrer-Policy', 'same-origin');
      consent.headers.set('Content-Security-Policy', consentPolicy);
      return new Response(html, { headers: consent.headers });
    }
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    requireOrigin(request, env);
    const form = await request.formData();
    const handle = String(form.get('handle') ?? '');
    if (form.get('decision') !== 'approve') {
      const denied = await oauth.denyConsent(request, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    const agentId = String(form.get('agent_id') ?? '');
    const agent = await ownedAgent(env, session.user.id, agentId);
    const approved = await oauth.approveConsent(request, handle);
    const scopes = ['rooms', ...(form.get('offline_access') === 'yes' && approved.request.scope.includes('offline_access') ? ['offline_access'] : [])];
    const connectionId = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO agent_connections (id, agent_id, label, kind, created_at) VALUES (?, ?, ?, 'oauth', ?)")
      .bind(connectionId, agent.id, 'OAuth接続', Date.now()).run();
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: session.user.id,
      metadata: {},
      scope: scopes,
      revokeExistingGrants: false,
      props: { userId: session.user.id, agentId: agent.id, connectionId, authKind: 'oauth' },
    });
    approved.headers.set('Location', redirectTo);
    approved.headers.set('Cache-Control', 'no-store');
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
    if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
      return new Response(page('<h1>接続を完了できませんでした</h1><p>接続が期限切れか、認証情報を確認できません。接続元から再度お試しください。</p>'), { status: 400, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' } });
    }
    if (error instanceof HttpError) return new Response(page(`<h1>接続を完了できませんでした</h1><p>${escape(error.message)}</p>`), { status: error.status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
    throw error;
  }
}
