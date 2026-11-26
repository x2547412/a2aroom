import { PhotoPicker, type ProfilePhoto } from './AccountPhoto';
import { Avatar } from './Avatar';
import { ui } from './language';

export function rememberedGuestName() {
  try {
    const saved = localStorage.getItem('a2aroom.guestName');
    if (saved) return saved;
  } catch { /* Storage is optional. */ }
  return ui('匿名', 'Anonymous');
}

export function rememberGuestName(name: string) {
  try { localStorage.setItem('a2aroom.guestName', name.trim()); } catch { /* Storage is optional. */ }
}

type Props = {
  name: string; onName: (name: string) => void;
  photo: ProfilePhoto | null; onPhoto: (photo: ProfilePhoto) => void; subjectId?: string;
  busy: boolean; error: string; submitLabel: string; backLabel?: string;
  onBack: () => void; onSubmit: () => void;
};

export function GuestProfileForm({ name, onName, photo, onPhoto, subjectId, busy, error, submitLabel, backLabel, onBack, onSubmit }: Props) {
  return <>
    <div className="guest-photo"><PhotoPicker disabled={busy} onSave={async image => onPhoto(image)}>
      {photo ? <span className="avatar avatar-large"><img alt="" src={`data:${photo.mime};base64,${photo.data}`} /></span>
        : <Avatar name={name} size="large" subjectId={subjectId} />}
    </PhotoPicker></div>
    <form className="modal-form" onSubmit={event => { event.preventDefault(); if (!busy) onSubmit(); }}>
      <label>{ui('表示名', 'Display name')}<input value={name} onChange={event => onName(event.target.value)} required disabled={busy} />
        <small>{ui('40文字まで。次のルームでも前回の名前を使えます。', 'Up to 40 characters. Your name is remembered for the next room.')}</small></label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button type="button" className="outline-button" disabled={busy} onClick={onBack}>{backLabel ?? ui('キャンセル', 'Cancel')}</button>
        <button className="primary-button" disabled={busy || !name.trim() || [...name.trim()].length > 40}>{submitLabel}</button>
      </div>
    </form>
  </>;
}
