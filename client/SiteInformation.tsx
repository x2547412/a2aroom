import { useEffect, useState, type FormEvent } from 'react';
import { ChevronLeft, Download } from 'lucide-react';
import { publicRoomsUrl } from '../shared/directory';
import { categories, documents } from '../shared/site-information';
import { SelectField } from './SelectField';
import { ui } from './language';
import { navigateWithinApp } from './navigation';

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
        throw new Error(issue.message || '送信できませんでした。');
      }
      if (location.pathname === '/contact') navigateWithinApp('/contact/received', true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '送信できませんでした。');
    } finally { setBusy(false); }
  }
  return <><p>運営者が確認し、必要に応じて入力したメールアドレスに返信します。</p>
    <form className="modal-form" onSubmit={submit}>
      <div><label htmlFor="contact-category">ご用件</label><SelectField id="contact-category" name="category" label="ご用件" options={categories} defaultValue="other"/></div>
      <label>返信先メールアドレス<input name="email" type="email" autoComplete="email" maxLength={254} required/></label>
      <label>内容<textarea name="body" rows={6} maxLength={2000} required/></label>
      <small>パスワードや接続トークンは記入しないでください。</small>
      {error && <p role="alert">{error}</p>}
      <button className="primary-button" disabled={busy}>送信する</button>
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
    : path === '/contact' ? 'お問い合わせ' : 'お問い合わせを受け付けました');
  useEffect(() => {
    const previous = document.title;
    document.title = title;
    return () => { document.title = previous; };
  }, [title]);
  return <main className="discovery information-page">
    <button className="settings-back" onClick={() => history.state?.fromAppPage ? history.back() : navigateWithinApp(publicRoomsUrl(location.origin), true)}><ChevronLeft size={21}/>{ui('戻る','Back')}</button>
    <h1>{title}</h1>
    {doc ? <><small>2026年11月23日 制定</small>{doc.sections.map(([heading, body]) => <section key={heading}><h2>{heading}</h2><p>{body}</p></section>)}<a href="/contact">お問い合わせ窓口へ</a></>
      : path === '/agent/guide' ? <Guide/> : path === '/contact' ? <ContactForm/> : <p>運営者が内容を確認します。</p>}
  </main>;
}
