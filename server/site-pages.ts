import { bodyLimit } from 'hono/body-limit';
import { Hono } from 'hono';
import { html } from 'hono/html';
import { directoryPage } from './directory';
import { subscribeDirectory } from './directory-hub';
import { enforceIpRate, getSession, requireOrigin } from './security';
import { HttpError, type Bindings } from './types';

import { documents, categories } from '../shared/site-information';

const footer = html`<footer>
  <nav aria-label="運営情報">
    <a href="/terms">利用規約</a><a href="/privacy">プライバシーポリシー</a><a href="/guidelines">ガイドライン</a
    ><a href="/contact">お問い合わせ</a>
  </nav>
</footer>`;
function page(title: string, content: ReturnType<typeof html>, selectField = false) {
  return html`<!doctype html>
    <html lang="ja">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
        <meta name="color-scheme" content="light dark" />
        <title>${title}</title>
        <link rel="icon" href="/icons/favicon-32.png?v=4" />
        <link rel="stylesheet" href="/site-pages.css" />
        <script src="/theme.js"></script>
        ${selectField && html`<link rel="stylesheet" href="/room-select.css" /><script type="module" src="/assets/form-select.js"></script>`}
      </head>
      <body>
        <header><a href="/explore"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>公開ルーム</a></header>
        <main>
          <h1>${title}</h1>
          ${content}
        </main>
        ${footer}
      </body>
    </html>`;
}

export const site = new Hono<{ Bindings: Bindings }>();
site.use('/contact', bodyLimit({ maxSize: 32768, onError: (c) => c.text('入力が長すぎます。', 413) }));
site.use('/contact*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
});
for (const [slug, doc] of Object.entries(documents)) {
  site.get('/' + slug, (c) =>
    c.html(
      page(
        doc.title,
        html`<p class="date">2026年11月23日 制定</p>
          ${doc.sections.map(
            ([title, body]) =>
              html`<section>
                <h2>${title}</h2>
                <p>${body}</p>
              </section>`,
          )}
          <p><a href="/contact">お問い合わせ窓口へ</a></p>`,
      ),
    ),
  );
}

function contactForm(error = '', email = '', body = '', category = 'other') {
  return page(
    'お問い合わせ',
    html`<p>運営者が確認し、必要に応じて入力したメールアドレスに返信します。</p>
      <form method="post" action="/contact">
        <div><label for="contact-category">ご用件</label><div data-select-field><span class="room-select-native">
          <select id="contact-category" name="category">
            ${Object.entries(categories).map(([key, label]) => (key === category ? html`<option value="${key}" selected>${label}</option>` : html`<option value="${key}">${label}</option>`))}
          </select></span></div></div>
        <label
          >返信先メールアドレス<input
            type="email"
            name="email"
            maxlength="254"
            autocomplete="email"
            required
            value="${email}"
        /></label>
        <label>内容<textarea name="body" rows="6" maxlength="2000" required>${body}</textarea></label>
        <small>パスワードや接続トークンは記入しないでください。</small
        >${error && html`<p class="error" role="alert">${error}</p>`}<button>送信する</button>
      </form>`,
    true,
  );
}
site.get('/contact', (c) => c.html(contactForm()));
site.get('/contact/received', (c) =>
  c.html(
    page(
      'お問い合わせを受け付けました',
      html`<p>運営者が内容を確認します。</p>
        <p><a href="/explore">公開ルームに戻る</a></p>`,
    ),
  ),
);
site.post('/contact', async (c) => {
  requireOrigin(c.req.raw, c.env);
  if (!(c.req.header('content-type') ?? '').startsWith('application/x-www-form-urlencoded'))
    throw new HttpError(415, 'FORM_REQUIRED', '画面のフォームから送信してください。');
  const data = new URLSearchParams(await c.req.text());
  const email = (data.get('email') ?? '').trim(),
    body = (data.get('body') ?? '').trim(),
    category = data.get('category') ?? '';
  const json = c.req.header('Accept') === 'application/json';
  function invalid(message: string, status: 400 | 429) {
    return json ? c.json({message}, status) : c.html(contactForm(message, email, body, category), status);
  }
  if (
    !Object.hasOwn(categories, category) ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    email.length > 254 ||
    !body ||
    [...body].length > 2000
  )
    return invalid('返信先と2,000文字以内の内容を確認してください。', 400);
  try {
    await enforceIpRate(c.env, c.req.raw, 'site-contact', 5, 60 * 60_000);
  } catch (error) {
    if (!(error instanceof HttpError) || error.status !== 429) throw error;
    return invalid('送信回数の上限に達しました。時間をおいて再度お試しください。', 429);
  }
  await c.env.DB.prepare('INSERT INTO site_inquiries(id,category,email,body,created_at) VALUES(?,?,?,?,?)')
    .bind(crypto.randomUUID(), category, email, body, Date.now())
    .run();
  return json ? c.json({received:true}, 201) : c.redirect('/contact/received', 303);
});

site.get('/api/explore/rooms', async c => {
  const session = await getSession(c.req.raw, c.env);
  c.header('Cache-Control', 'private, no-store');
  return c.json(await directoryPage(c.env, new URL(c.req.url), session?.user.id));
});
site.get('/api/explore/live', (c) => subscribeDirectory(c.env, c.req.raw));

export function directoryAsset(path: string) {
  return (
    path === '/' ||
    path === '/explore' ||
    path === '/theme.js' ||
    path === '/site-pages.css' ||
    path === '/brand-buttons.css' ||
    path === '/room-select.css' ||
    path === '/site.webmanifest' ||
    path.startsWith('/assets/') ||
    path.startsWith('/stickers/') ||
    path.startsWith('/icons/')
  );
}
