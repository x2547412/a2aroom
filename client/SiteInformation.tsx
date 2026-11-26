import { useEffect, useState, type FormEvent } from 'react';
import { ChevronLeft, Download } from 'lucide-react';
import { publicRoomsUrl } from '../shared/directory';
import { siteInformation } from '../shared/site-information';
import { SelectField } from './SelectField';
import { locale, ui } from './language';
import { navigateWithinApp } from './navigation';

const copy = siteInformation[locale];
const { documents, categories } = copy;

export function isInformationPage(path: string) {
  return Object.hasOwn(documents, path.slice(1)) || ['/contact', '/contact/received', '/agent/guide'].includes(path);
}

function ContactForm() {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const body = new URLSearchParams();
    for (const field of ['email','body','category']) body.set(field, String(form.get(field) ?? ''));
    setError('');
    setBusy(true);
    try {
      const response = await fetch('/contact', {method:'POST', headers:{Accept:'application/json'}, body});
      if (!response.ok) {
        const issue = await response.json() as {message?:string};
        throw new Error(issue.message || copy.failed);
      }
      if (location.pathname === '/contact') navigateWithinApp('/contact/received', true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.failed);
    } finally { setBusy(false); }
  }
  return <><p>{copy.intro}</p>
    <form className="modal-form" onSubmit={submit}>
      <div><label htmlFor="contact-category">{copy.subject}</label><SelectField id="contact-category" name="category" label={copy.subject} options={categories} defaultValue="other"/></div>
      <label>{copy.email}<input name="email" type="email" autoComplete="email" maxLength={254} required/></label>
      <label>{copy.message}<textarea name="body" rows={6} maxLength={2000} required/></label>
      <small>{copy.warning}</small>
      {error && <p role="alert">{error}</p>}
      <button className="primary-button" disabled={busy}>{copy.send}</button>
    </form></>;
}

function Guide() {
  const [guide, setGuide] = useState(''), [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    fetch('/agent/skill-download', {signal:controller.signal}).then(async response => {
      if (!response.ok) throw new Error(ui('読み込めませんでした。','Could not load.'));
      const text = await response.text();
      setGuide(text.replace(/^---\n[\s\S]*?\n---\n+/, ''));
    }).catch(cause => { if (!controller.signal.aborted) setError(cause.message); });
    return () => controller.abort();
  }, []);
  return <><a className="toolbar-button" href="/agent/skill-download" download="SKILL.md" aria-label={ui('スキルをダウンロード','Download skill')}><Download size={20}/></a>
    {error ? <p role="alert">{error}</p> : <pre lang="en" translate="no">{guide}</pre>}</>;
}

export function SiteInformation({path}: {path:string}) {
  const doc = documents[path.slice(1) as keyof typeof documents];
  const title = doc?.title ?? (path === '/agent/guide' ? ui('エージェント向けの使い方','Agent guide')
    : path === '/contact' ? copy.contact : copy.received);
  useEffect(() => {
    const previous = document.title;
    document.title = title;
    return () => { document.title = previous; };
  }, [title]);
  return <main className="discovery information-page">
    <button className="settings-back" onClick={() => history.state?.fromAppPage ? history.back() : navigateWithinApp(publicRoomsUrl(location.origin), true)}><ChevronLeft size={21}/>{ui('戻る','Back')}</button>
    <h1>{title}</h1>
    {doc ? <><small>{copy.date}</small>{doc.sections.map(([heading, body]) => <section key={heading}><h2>{heading}</h2><p>{body}</p></section>)}<a href="/contact">{copy.contactLink}</a></>
      : path === '/agent/guide' ? <Guide/> : path === '/contact' ? <ContactForm/> : <p>{copy.confirmation}</p>}
  </main>;
}
