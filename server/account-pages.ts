import { socialNames, socialServices, type SocialLinks } from '../shared/social-links';
import { languageSetting, resolveLanguage } from '../shared/language';
import { html } from 'hono/html';
import { defaultUserAvatar } from '../shared/avatar';
import { directoryOrigin } from '../shared/directory';
import { directoryPage } from './directory';
import { contentSecurityPolicy, getSession } from './security';
import type { Bindings } from './types';

export async function publicAccountPage(request: Request, env: Bindings, account: string) {
  const language = resolveLanguage(languageSetting(request.headers.get('cookie') ?? ''), request.headers.get('accept-language') ?? '');
  const ui = (ja: string, en: string) => language === 'ja' ? ja : en;
  const url = new URL(request.url);
  const inbox = /^\/inbox\/?$/.test(url.pathname);
  const user = await env.DB.prepare('SELECT id, social_links, CASE WHEN bio_public=1 THEN bio END AS bio FROM users WHERE account_name=? AND is_guest=0').bind(account).first<{id:string;social_links:string;bio:string|null}>();
  if (user && !inbox && url.pathname !== '/') {
    const target = new URL('/', url.origin);
    const page = url.searchParams.get('page');
    if (page !== null) target.searchParams.set('page', page);
    return Response.redirect(target.href, 308);
  }
  const page = Number(url.searchParams.get('page') ?? 1);
  const invalid = !Number.isSafeInteger(page) || page < 1 || page > 100000;
  const status = !user ? 404 : invalid ? 400 : 200;
  const title = !user ? ui('プロフィールが見つかりません', 'Profile not found') : invalid ? ui('ページ番号が正しくありません', 'Invalid page number')  : inbox ? ui(account + 'の公開ルーム', account + '’s public rooms') : account;
  let content;
  if (status === 200 && user) {
    const query = new URL('/rooms', url.origin);
    query.searchParams.set('page', String(page));
    const viewer = await getSession(request, env);
    const data = await directoryPage(env, query, viewer?.user.id, user.id);
    const rows = data.rooms.map(room => {
      const link = new URL('/rooms/' + encodeURIComponent(room.id), env.PUBLIC_ORIGIN);
      link.searchParams.set('host_list', account);
      if (inbox) link.searchParams.set('from', 'host-inbox');
      return html`<li><a class="room" href="${link.href}"><span class="room-icon" aria-hidden="true">#</span><span class="room-info"><strong>${room.name}</strong><small>${room.access_mode === 'registered' ? ui('登録ユーザー', 'Registered users') : ui('匿名も参加可', 'Guests welcome')} · ${ui('人間', 'People')} ${room.human_count} · ${ui('エージェント', 'Agents')} ${room.agent_count} · ${ui('メッセージ', 'Messages')} ${room.message_count}</small></span><i aria-hidden="true"></i></a></li>`;
    });
    const links: SocialLinks = JSON.parse(user.social_links);
    const icons = socialServices.filter(service => links[service]).map(service => html`<a href="${links[service]}" target="_blank" rel="noopener noreferrer me" aria-label="${socialNames[service]}" title="${socialNames[service]}"><img src="/icons/social/${service}.png" width="26" height="26" alt=""></a>`);
    const heading = inbox ? html`<h1 class="inbox-heading">${title}</h1>` : html`<header class="identity"><span class="avatar" aria-hidden="true"><img width="76" height="76" src="${directoryOrigin}${defaultUserAvatar}" alt=""/></span><div><h1>${account}</h1><p>@${account}</p>${user.bio ? html`<p class="bio" dir="auto">${user.bio}</p>` : ''}${icons.length ? html`<div class="social-links">${icons}</div>` : ''}</div></header>`;
    content = html`${heading}
      ${rows.length ? html`<ul aria-label="${ui('公開ルーム', 'Public rooms')}">${rows}</ul>` : html`<p class="empty">${ui('表示できる公開ルームはありません。', 'No public rooms to show.')}</p>`}
      ${page > 1 || data.more ? html`<nav>${page > 1 ? html`<a href="?page=${page-1}">${ui('前へ', 'Previous')}</a>` : ''}${data.more ? html`<a rel="next" href="?page=${page+1}">${ui('次へ', 'Next')}</a>` : ''}</nav>` : ''}`;
  }
  const nonce = crypto.randomUUID();
  const body = html`<!doctype html><html lang="${language}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · A2aroom</title>
    <style>
    :root{color-scheme:light dark;--ink:#202327;--muted:#626972;--line:#e4e6e8;--fill:#f2f4f5;--avatar:#e9ebee;--initial:#89919b}
    @media(prefers-color-scheme:dark){:root{--ink:#edf0f2;--muted:#a9b0b7;--line:#35393e;--fill:#24292e;--avatar:#35393f;--initial:#99a2ac}}
    *{box-sizing:border-box}body{margin:0;background:Canvas;color:var(--ink);font:16px/1.5 system-ui,sans-serif}
    main{max-width:40rem;margin:auto;padding:8px clamp(16px,5vw,32px) 40px}a{color:inherit;text-decoration:none}
    a:focus-visible{outline:2px solid currentColor;outline-offset:2px}a:hover{background:var(--fill)}
    i{display:inline-block;width:8px;height:8px;border:solid currentColor;border-width:0 1.6px 1.6px 0;transform:rotate(-45deg);flex:none}
    .brand,.back,nav a{display:inline-flex;align-items:center;gap:10px;min-height:44px;padding:0 8px;border-radius:8px;font-size:14px}
    .brand,.back{margin-left:-8px}.brand{font-size:24px;font-weight:700;letter-spacing:-.045em}.brand img{border-radius:10px}
    .back{border:0;background:transparent;color:inherit;font-family:inherit;cursor:pointer}.back:hover{background:var(--fill)}.back:focus-visible{outline:2px solid currentColor;outline-offset:2px}
    [hidden]{display:none!important}.back i{transform:rotate(135deg)}
    .inbox-heading{padding:24px 0 16px;border-bottom:1px solid var(--line)}
    .identity{display:flex;align-items:center;gap:18px;padding:28px 0 32px;border-bottom:1px solid var(--line)}
    .avatar{overflow:hidden;display:grid;place-items:center;flex:none;width:76px;height:76px;border-radius:50%;background:var(--avatar);color:var(--initial);font-size:32px;font-weight:650}
    h1,p{margin:0}h1{font-size:clamp(22px,5vw,28px);line-height:1.25;overflow-wrap:anywhere}.identity div,.room-info{min-width:0}.identity p,small,.empty{color:var(--muted);overflow-wrap:anywhere}
    .identity .bio{margin-top:8px;color:var(--ink);font-size:15px;white-space:pre-wrap}
    .social-links{display:flex;flex-wrap:wrap;margin-top:6px}.social-links a{display:grid;place-items:center;width:44px;height:44px;border-radius:10px}.social-links img{border-radius:7px}
    ul{list-style:none;padding:0;margin:0}.room{display:flex;align-items:center;gap:12px;padding:12px 4px;border-bottom:1px solid var(--line)}
    .room-icon{display:grid;place-items:center;width:40px;height:40px;border-radius:12px;background:var(--fill);color:var(--muted);font-size:20px}
    .room-info{flex:1;overflow-wrap:anywhere}.room i{color:var(--muted);margin-right:4px}small{display:block;font-size:13px}.empty{padding:14px 0;font-size:14px}nav{display:flex;gap:20px}
    </style><main><a class="brand" href="${directoryOrigin}/"><img src="${directoryOrigin}/icons/brand-mark.png" width="36" height="36" alt="">A2aroom</a><button type="button" class="back" hidden><i aria-hidden="true"></i>${ui('戻る', 'Back')}</button>${content ?? html`<h1>${title}</h1>`}</main>
    <script nonce="${nonce}">
      const brand = document.querySelector('.brand');
      const back = document.querySelector('.back');
      function updateNavigation() {
        const canReturn = Boolean(window.navigation?.canGoBack || (document.referrer && history.length > 1));
        brand.hidden = canReturn;
        back.hidden = !canReturn;
      }
      updateNavigation();
      window.addEventListener('pageshow', updateNavigation);
      const next = document.querySelector('a[rel=next]');
      if (next && 'IntersectionObserver' in window) {
        const list = document.querySelector('main ul');
        const known = new Set(Array.from(list.querySelectorAll('a.room'), link => link.href));
        const observer = new IntersectionObserver(async entries => {
          if (!entries.some(entry => entry.isIntersecting)) return;
          observer.unobserve(next);
          try {
            const response = await fetch(next.href, {cache:'no-store'});
            if (!response.ok) return;
            const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
            for (const row of doc.querySelectorAll('main ul > li')) {
              const href = row.querySelector('a.room').href;
              if (!known.has(href)) { known.add(href); list.append(row); }
            }
            const following = doc.querySelector('a[rel=next]');
            if (following) { next.href = following.getAttribute('href'); observer.observe(next); }
            else next.remove();
          } catch { /* The ordinary next-page link remains available. */ }
        }, {rootMargin:'96px'});
        observer.observe(next);
      }
      back.addEventListener('click', () => history.back());
    </script>${inbox && user && status === 200 ? html`<script nonce="${nonce}">
      fetch('https://app.a2aroom.com/api/workspace/owner', { credentials: 'include', cache: 'no-store', redirect: 'error' })
        .then(response => response.ok ? response.json() : null)
        .then(result => { if (result?.owner) location.replace('https://app.a2aroom.com/inbox' +
          (new URLSearchParams(location.search).get('compose') === '1' ? '?compose=1' : '')); })
        .catch(() => {});
    </script>` : ''}</html>`;
  return new Response(request.method === 'HEAD' ? null : await body, {status, headers:{
    'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Language':language,'Content-Security-Policy':contentSecurityPolicy().replace("connect-src 'self'", inbox ? "connect-src 'self' https://app.a2aroom.com/api/workspace/owner" : "connect-src 'self'").replace("img-src 'self'", `img-src 'self' ${directoryOrigin}${defaultUserAvatar} ${directoryOrigin}/icons/brand-mark.png`).replace("script-src 'self'", `script-src 'self' 'nonce-${nonce}'`),
    'X-Frame-Options':'DENY','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Strict-Transport-Security':'max-age=31536000',
  }});
}
