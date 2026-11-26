import { useEffect, useState } from 'react';
import { socialNames, socialServices, socialUrl, type SocialLinks } from '../shared/social-links';
import { request } from './api';
import { ui } from './language';
import { Modal } from './Modal';

export function SocialIcons({ links }: { links: SocialLinks }) {
  const services = socialServices.filter(service => links[service]);
  if (!services.length) return null;
  return <div className="social-links">{services.map(service => <a key={service} href={links[service]}
    target="_blank" rel="noopener noreferrer me" title={socialNames[service]} aria-label={socialNames[service]}>
    <img src={'/icons/social/' + service + '.png'} width="26" height="26" alt="" />
  </a>)}</div>;
}

export function SocialLinkSettings() {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<SocialLinks | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const title = ui('SNSリンク', 'Social links');
  useEffect(() => {
    if (!open) return;
    let active = true;
    request<SocialLinks>('/account/profile/social-links').then(links => { if (active) setDraft(links); })
      .catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [open]);
  return <>
    <button className="outline-button compact" onClick={() => { setError(''); setDraft(null); setOpen(true); }}>{title}</button>
    {open && <Modal title={title} closeDisabled={busy} onClose={() => setOpen(false)}>
      <form className="modal-form" onSubmit={async e => {
        e.preventDefault();
        if (!draft || busy) return;
        setBusy(true); setError('');
        try {
          await request('/account/profile/social-links', {method:'PUT', body:draft});
          setOpen(false);
        } catch (cause) { setError(cause instanceof Error ? cause.message : ui('保存できませんでした。','Could not save links.')); }
        finally { setBusy(false); }
      }}>
        <p>{ui('登録したリンクは公開プロフィールとルーム内のプロフィールに表示されます。','Saved links appear on your public and room profiles.')}</p>
        {draft ? socialServices.map(service => <label key={service}>{socialNames[service]}{service === 'setlog' && ui('（招待リンク）',' (invite link)')}
          <input type="url" inputMode="url" autoCapitalize="none" spellCheck={false} placeholder="https://" disabled={busy} value={draft[service] ?? ''}
            onChange={e => {
              const value = e.currentTarget.value.trim();
              e.currentTarget.setCustomValidity(value && !socialUrl(service,value)
                ? ui(service === 'setlog' ? 'Setlogの招待URLを入力してください。' : socialNames[service]+'のプロフィールURLを入力してください。',
                    service === 'setlog' ? 'Enter a Setlog invite URL.' : 'Enter a '+socialNames[service]+' profile URL.') : '');
              setDraft({...draft, [service]:value});
            }} />
        </label>) : !error && <p role="status">{ui('読み込み中…','Loading…')}</p>}
        {error && <p role="alert" className="form-error">{error}</p>}
        <div className="dialog-actions"><button type="button" className="outline-button" disabled={busy} onClick={() => setOpen(false)}>{ui('キャンセル','Cancel')}</button>
          <button className="primary-button" disabled={!draft || busy}>{ui('保存','Save')}</button></div>
      </form>
    </Modal>}
  </>;
}
