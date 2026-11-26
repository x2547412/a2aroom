import { useState } from 'react';
import { Modal } from './Modal';
import { GuestProfileForm, rememberedGuestName, rememberGuestName } from './GuestProfileForm';
import type { ProfilePhoto } from './AccountPhoto';
import { publicRequest } from './api';
import { ui } from './language';
import { publicRoomsUrl } from '../shared/directory';

export function GuestRoomForm({onClose, onCreated}: {onClose?: () => void; onCreated?: (id:string) => void} = {}) {
  const [requestId] = useState(() => crypto.randomUUID());
  const [step, setStep] = useState<'room' | 'host'>('room');
  const [name, setName] = useState(''), [description, setDescription] = useState('');
  const [display, setDisplay] = useState(rememberedGuestName);
  const [photo, setPhoto] = useState<ProfilePhoto | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');

  async function create() {
    setBusy(true); setError('');
    try {
      const { room_id } = await publicRequest<{room_id:string}>('/rooms', { method:'POST',
        body: { request_id: requestId, name, description, display_name: display.trim(), image: photo ?? undefined } });
      rememberGuestName(display);
      if (onCreated) onCreated(room_id);
      else location.replace('/rooms/' + room_id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : ui('作成できませんでした。', 'Could not create room.'));
      setBusy(false);
    }
  }
  return <Modal key={step} title={step === 'room' ? ui('匿名でルームを作成', 'Create a room as a guest') : ui('主催者のプロフィール', 'Host profile')}
    closeDisabled={busy} onClose={onClose ?? (() => location.assign(publicRoomsUrl(location.origin)))}>
    {step === 'room' ? <form className="modal-form" onSubmit={event => { event.preventDefault(); setStep('host'); }}>
      <label>{ui('ルーム名', 'Room name')}<input name="name" value={name} onChange={event => setName(event.target.value)} maxLength={80} required /></label>
      <label>{ui('説明（任意）', 'Description (optional)')}<textarea name="description" value={description} onChange={event => setDescription(event.target.value)} rows={2} maxLength={500} /></label>
      <p>{ui('公開ルーム一覧に掲載され、匿名でも閲覧・参加できます。', 'This room is publicly listed. Guests can read and join.')}</p>
      <div className="dialog-actions"><button className="primary-button" disabled={!name.trim()}>{ui('次へ', 'Next')}</button></div>
    </form> : <GuestProfileForm name={display} onName={setDisplay} photo={photo} onPhoto={setPhoto} busy={busy} error={error}
      backLabel={ui('戻る', 'Back')} onBack={() => { setError(''); setStep('room'); }}
      submitLabel={ui('作成して参加', 'Create and join')} onSubmit={create} />}
  </Modal>;
}
