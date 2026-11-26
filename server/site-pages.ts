import { archiveIdentity, verificationArchive } from './verification';
import { bodyLimit } from 'hono/body-limit';
import { Hono, type Context } from 'hono';
import { html } from 'hono/html';
import { directoryPage } from './directory';
import { subscribeDirectory } from './directory-hub';
import { enforceIpRate, getSession, requireOrigin } from './security';
import { HttpError, type Bindings } from './types';

import { siteInformation } from '../shared/site-information';
import { languageSetting, resolveLanguage, type Language } from '../shared/language';

function pageLanguage(c: Context) {
  const lang = resolveLanguage(languageSetting(c.req.header('Cookie') ?? ''), c.req.header('Accept-Language') ?? '');
  c.header('Content-Language', lang);
  c.header('Vary', 'Cookie, Accept-Language');
  c.header('Cache-Control', 'private, no-store');
  return lang;
}

function page(lang: Language, title: string, content: ReturnType<typeof html>, selectField = false) {
  const copy = siteInformation[lang];
  return html`<!doctype html>
    <html lang="${lang}">
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
          stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>${copy.rooms}</a></header>
        <main>
          <h1>${title}</h1>
          ${content}
        </main>
        <footer><nav aria-label="${copy.footer}">
          <a href="/terms">${copy.documents.terms.title}</a><a href="/privacy">${copy.documents.privacy.title}</a>
          <a href="/guidelines">${copy.guidelinesLink}</a><a href="/contact">${copy.contact}</a>
        </nav></footer>
      </body>
    </html>`;
}

export const site = new Hono<{ Bindings: Bindings }>();
site.use('/contact', bodyLimit({ maxSize: 32768, onError: (c) => c.text(siteInformation[pageLanguage(c)].tooLong, 413) }));
for (const slug of Object.keys(siteInformation.ja.documents) as (keyof typeof siteInformation.ja.documents)[]) {
  site.get('/' + slug, (c) => {
    const lang = pageLanguage(c);
    const copy = siteInformation[lang];
    const doc = copy.documents[slug];
    return c.html(page(lang, doc.title, html`<p class="date">${copy.date}</p>
      ${doc.sections.map(([title, body]) => html`<section><h2>${title}</h2><p>${body}</p></section>`)}
      <p><a href="/contact">${copy.contactLink}</a></p>`));
  });
}

function contactForm(lang: Language, error = '', email = '', body = '', category = 'other') {
  const copy = siteInformation[lang];
  return page(lang, copy.contact,
    html`<p>${copy.intro}</p>
      <form method="post" action="/contact">
        <div><label for="contact-category">${copy.subject}</label><div data-select-field><span class="room-select-native">
          <select id="contact-category" name="category">
            ${Object.entries(copy.categories).map(([key, label]) => (key === category ? html`<option value="${key}" selected>${label}</option>` : html`<option value="${key}">${label}</option>`))}
          </select></span></div></div>
        <label
          >${copy.email}<input
            type="email"
            name="email"
            maxlength="254"
            autocomplete="email"
            required
            value="${email}"
        /></label>
        <label>${copy.message}<textarea name="body" rows="6" maxlength="2000" required>${body}</textarea></label>
        <small>${copy.warning}</small
        >${error && html`<p class="error" role="alert">${error}</p>`}<button>${copy.send}</button>
      </form>`,
    true,
  );
}
site.get('/contact', (c) => c.html(contactForm(pageLanguage(c))));
site.get('/contact/received', (c) => {
  const lang = pageLanguage(c);
  const copy = siteInformation[lang];
  return c.html(page(lang, copy.received, html`<p>${copy.confirmation}</p>
    <p><a href="/explore">${copy.returnToRooms}</a></p>`));
});
site.post('/contact', async (c) => {
  const lang = pageLanguage(c);
  const copy = siteInformation[lang];
  requireOrigin(c.req.raw, c.env);
  if (!(c.req.header('content-type') ?? '').startsWith('application/x-www-form-urlencoded'))
    throw new HttpError(415, 'FORM_REQUIRED', copy.formRequired);
  const data = new URLSearchParams(await c.req.text());
  const email = (data.get('email') ?? '').trim(),
    body = (data.get('body') ?? '').trim(),
    category = data.get('category') ?? '';
  const json = c.req.header('Accept') === 'application/json';
  function invalid(message: string, status: 400 | 429) {
    return json ? c.json({message}, status) : c.html(contactForm(lang, message, email, body, category), status);
  }
  if (
    !Object.hasOwn(copy.categories, category) ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    email.length > 254 ||
    !body ||
    [...body].length > 2000
  )
    return invalid(copy.invalid, 400);
  try {
    await enforceIpRate(c.env, c.req.raw, 'site-contact', 5, 60 * 60_000);
  } catch (error) {
    if (!(error instanceof HttpError) || error.status !== 429) throw error;
    return invalid(copy.rateLimit, 429);
  }
  await c.env.DB.prepare('INSERT INTO site_inquiries(id,category,email,body,created_at) VALUES(?,?,?,?,?)')
    .bind(crypto.randomUUID(), category, email, body, Date.now())
    .run();
  return json ? c.json({received:true}, 201) : c.redirect('/contact/received', 303);
});

site.get('/api/explore/verification', async c => {
  c.header('Cache-Control','private, no-store');
  await enforceIpRate(c.env,c.req.raw,'verification-archive',600,3600_000);
  const {viewer,guestHashes}=await archiveIdentity(c.req.raw,c.env);
  const before=c.req.query('before_seq');
  return c.json(await verificationArchive(c.env,viewer,{query:c.req.query('query'),before_seq:before===undefined ? undefined : Number(before)},guestHashes));
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
