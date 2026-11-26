import { ui } from './language';
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight, Globe2, LockKeyhole, Users } from 'lucide-react';
import type { AccessMode } from './api';
import { Modal } from './Modal';

const choices = {
  invite: { label: ui("招待制", "Invite only"), description: ui("招待された人だけが参加", "Only invited people can join"), icon: LockKeyhole },
  registered: { label: ui("登録ユーザー", "Registered users"), description: ui("登録してログインした人が参加", "Sign in with a registered account to join"), icon: Users },
  anonymous: { label: ui("匿名も参加可", "Guests welcome"), description: ui("人もAIも登録せずに閲覧・投稿できる", "People and AI can read and post without registering"), icon: Globe2 },
} as const;

export const accessLabel = (mode: AccessMode) => choices[mode].label;
type Props = { mode: AccessMode; listed: boolean; privateBeta: boolean; onConfirm: (mode: AccessMode, listed: boolean) => void | Promise<void> };

export function RoomAccessField(props: Props) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className="access-field" aria-haspopup="dialog" onClick={() => setOpen(true)}>
      <strong>{ui("公開範囲", "Visibility")}</strong><span>{accessLabel(props.mode)}</span><ChevronRight size={18} aria-hidden="true"/>
    </button>
    {open && createPortal(<AccessDialog {...props} onClose={() => setOpen(false)}/>, document.body)}
  </>;
}

function AccessDialog({ mode, listed, privateBeta, onConfirm, onClose }: Props & { onClose: () => void }) {
  const [selection, setSelection] = useState(mode);
  const [listRoom, setListRoom] = useState(listed);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function confirm() {
    const nextListed = selection !== 'invite' && listRoom;
    try {
      setError(''); setBusy(true);
      if (selection !== mode || nextListed !== (mode !== 'invite' && listed)) await onConfirm(selection, nextListed);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : ui("公開範囲を変更できませんでした。", "Could not change room visibility."));
    } finally { setBusy(false); }
  }
  return <Modal title={ui("公開範囲", "Visibility")} onClose={() => { if (!busy) onClose(); }}>
    <div className="access-dialog">
      <fieldset disabled={busy} aria-label={ui("参加方法", "Who can join")}><div className="choice-list">
        {(Object.keys(choices) as AccessMode[]).map(value => {
          const { label, description, icon: Icon } = choices[value];
          return <label key={value} className="choice"><Icon size={17} aria-hidden="true"/>
            <span><strong>{label}</strong><small>{description}</small></span>
            <input type="radio" name="room-access" checked={selection === value} onChange={() => setSelection(value)}/>
          </label>;
        })}
      </div></fieldset>
      {selection !== 'invite' && <label className="checkbox-label listing-choice"><input type="checkbox" disabled={busy} checked={listRoom} onChange={e => setListRoom(e.target.checked)}/>{ui("公開ルーム一覧に掲載する", "List in public rooms")} <small>{ui("掲載すると、過去の発言や添付もログインせずに閲覧できます。", "Anyone can read a listed room, including past messages and attachments, without signing in.")}</small></label>}
      {privateBeta && <p className="empty-inline">{ui("本人限定の利用期間中は、どの設定でも他の人は参加できません。", "Participation is restricted to the owner during the private beta.")}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button type="button" className="outline-button" disabled={busy} onClick={onClose}>{ui("キャンセル", "Cancel")}</button>
        <button type="button" className="primary-button" disabled={busy} onClick={() => void confirm()}>{busy ? ui("保存中…", "Saving…") : ui("決定", "Confirm")}</button></div>
    </div>
  </Modal>;
}
