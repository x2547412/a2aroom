import { SocialLinkSettings } from './SocialLinks';
import { ui } from './language';
import { directoryOrigin, isAccountOrigin } from '../shared/directory';
import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Camera, Minus, Plus } from 'lucide-react';
import { Avatar, ImageContext, imageSource } from './Avatar';
import { EditableName } from './EditableName';
import { Modal } from './Modal';
import { request, type User } from './api';

type Crop = { x: number; y: number; zoom: number };
const centered: Crop = { x: .5, y: .5, zoom: 1 };
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));

function cropBox(image: HTMLImageElement, crop: Crop) {
  const w = image.naturalWidth, h = image.naturalHeight;
  const size = Math.min(w, h) / crop.zoom;
  return { left: clamp(crop.x * w - size / 2, 0, w - size), top: clamp(crop.y * h - size / 2, 0, h - size), size };
}

async function encodePhoto(image: HTMLImageElement, crop: Crop) {
  const { left, top, size } = cropBox(image, crop);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error(ui("画像を処理できませんでした。", "Could not process the image."));
  for (const pixels of [256, 192, 128]) {
    canvas.width = canvas.height = pixels;
    ctx.drawImage(image, left, top, size, size, 0, 0, pixels, pixels);
    for (const quality of [.84, .68, .5]) {
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/webp', quality));
      if (!blob || blob.size > 40000) continue;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      return { mime: blob.type, data: btoa(String.fromCharCode(...bytes)) };
    }
  }
  throw new Error(ui("画像を小さくできませんでした。別の画像を選んでください。", "Choose a smaller image and try again."));
}

function CropPhoto({ file, onClose, onSave }: { file: File; onClose: () => void; onSave: (image: HTMLImageElement, crop: Crop) => Promise<void> }) {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [crop, setCrop] = useState<Crop>(centered);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const preview = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ id: number; x: number; y: number; crop: Crop } | null>(null);
  useEffect(() => {
    let active = true;
    const url = URL.createObjectURL(file), photo = new Image();
    photo.src = url;
    void photo.decode().then(() => {
      if (!active) return;
      if (!photo.naturalWidth || !photo.naturalHeight || photo.naturalWidth * photo.naturalHeight > 50_000_000) setError(ui("画像の大きさを確認してください。", "Check the image dimensions."));
      else setImage(photo);
    }).catch(() => { if (active) setError(ui("この画像を読み込めませんでした。", "Could not load this image.")); });
    return () => { active = false; URL.revokeObjectURL(url); };
  }, [file]);
  useLayoutEffect(() => {
    if (!image || !preview.current) return;
    const box = cropBox(image, crop);
    const canvas = preview.current, ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, box.left, box.top, box.size, box.size, 0, 0, canvas.width, canvas.height);
  }, [image, crop]);
  function pan(start: Crop, dx: number, dy: number) {
    if (!image) return;
    const box = cropBox(image, start);
    const left = clamp(box.left - dx * box.size, 0, image.naturalWidth - box.size);
    const top = clamp(box.top - dy * box.size, 0, image.naturalHeight - box.size);
    setCrop({ x: (left + box.size / 2) / image.naturalWidth, y: (top + box.size / 2) / image.naturalHeight, zoom: start.zoom });
  }
  async function save() {
    if (!image || busy) return;
    setBusy(true); setError('');
    try { await onSave(image, crop); onClose(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : ui("画像を保存できませんでした。", "Could not save the image.")); }
    finally { setBusy(false); }
  }
  return <Modal title={ui("画像をトリミング", "Crop image")} onClose={() => { if (!busy) onClose(); }}>
    <div className="crop-controls">
      <div className="crop-frame" tabIndex={0} role="group" aria-label={ui("切り抜く位置", "Crop position")} aria-describedby="crop-instructions"
        onPointerDown={e => {
          if (!image || busy || e.button !== 0 || !e.isPrimary) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, crop };
        }} onPointerMove={e => {
          const start = drag.current;
          if (!start || start.id !== e.pointerId) return;
          const width = e.currentTarget.clientWidth;
          pan(start.crop, (e.clientX - start.x) / width, (e.clientY - start.y) / width);
        }} onLostPointerCapture={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}
        onKeyDown={e => {
          if (busy || !['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)) return;
          e.preventDefault();
          pan(crop, e.key==='ArrowLeft' ? -.04 : e.key==='ArrowRight' ? .04 : 0, e.key==='ArrowUp' ? -.04 : e.key==='ArrowDown' ? .04 : 0);
        }}>
        <canvas ref={preview} width={480} height={480} />
      </div>
      <p id="crop-instructions">{ui("ドラッグか矢印キーで、丸の中に位置を合わせます。", "Drag or use the arrow keys to position the image inside the circle.")}</p>
      <label className="crop-zoom"><Minus aria-hidden="true" size={16} /><input type="range" aria-label={ui("拡大率", "Zoom")} min="1" max="4" step=".01" value={crop.zoom} disabled={!image || busy} onChange={e => setCrop({ ...crop, zoom: Number(e.target.value) })} /><Plus aria-hidden="true" size={18} /></label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button className="outline-button" disabled={busy} onClick={onClose}>{ui("キャンセル", "Cancel")}</button><button className="primary-button" disabled={!image || busy} onClick={() => void save()}>{busy ? ui("保存中…", "Saving…") : ui("保存", "Save")}</button></div>
    </div>
  </Modal>;
}

export type ProfilePhoto = { mime: string; data: string };
export function PhotoPicker({ children, disabled, onSave }: { children: React.ReactNode; disabled?: boolean; onSave: (photo: ProfilePhoto) => Promise<void> }) {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null), [error, setError] = useState('');
  return <>
    <button className="photo-trigger" type="button" aria-label={ui("プロフィール画像を変更", "Change profile photo")} disabled={disabled} onClick={() => input.current?.click()}>
      {children}<span><Camera size={14} /></span>
    </button>
    <input hidden type="file" ref={input} accept="image/jpeg,image/png,image/webp" onChange={e => {
      const selected = e.currentTarget.files?.[0]; e.currentTarget.value = '';
      if (!selected) return;
      if (!['image/jpeg','image/png','image/webp'].includes(selected.type) || selected.size > 10 * 1024 * 1024) { setError(ui("10MB以下のJPEG・PNG・WebP画像を選んでください。", "Choose a JPEG, PNG or WebP image under 10 MB.")); return; }
      setError(''); setFile(selected);
    }} />
    {error && <p className="form-error" role="alert">{error}</p>}
    {file && <CropPhoto file={file} onClose={() => setFile(null)} onSave={async (image, crop) => onSave(await encodePhoto(image, crop))} />}
  </>;
}

export function AccountPhoto({ user, onProfileSaved }: { user: User; onProfileSaved: (patch: Partial<Pick<User, 'bio' | 'bio_public' | 'display_name'>>) => void }) {
  const { images, refresh } = useContext(ImageContext);
  const [error, setError] = useState('');
  const [bio,setBio] = useState(user.bio ?? '');
  const [bioPublic,setBioPublic] = useState(Boolean(user.bio_public));
  const [bioBusy,setBioBusy] = useState(false), [bioStatus,setBioStatus] = useState('');
  const bioDirty = bio !== (user.bio ?? '') || bioPublic !== Boolean(user.bio_public);
  const [removing, setRemoving] = useState(false);
  const path = '/images/user/' + encodeURIComponent(user.id);
  async function remove() {
    setRemoving(true); setError('');
    try { await request(path, { method: 'DELETE' }); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : ui("画像を削除できませんでした。", "Could not remove the image.")); }
    finally { setRemoving(false); }
  }
  return <>
    <div className="settings-profile">
      <PhotoPicker disabled={removing} onSave={async body => { await request(path, { method: 'PUT', body }); await refresh(); }}>
        <Avatar name={user.display_name || user.account_name} size="large" subjectId={user.id} />
      </PhotoPicker>
      <div><EditableName dialog as="strong" name={user.display_name || user.account_name} onSave={async name => {
        const saved = await request<{ display_name: string }>('/account/profile', { method: 'PATCH', body: { display_name: name } });
        onProfileSaved(saved);
      }} /><small>{user.email}</small></div>
    </div>
    <div className="profile-id-row"><span>{ui("アカウントID", "Account ID")}</span><span className="profile-id-value">{(location.origin === directoryOrigin || isAccountOrigin(location.origin)) ? <a href={'https://' + user.account_name + '.a2aroom.com/'} aria-label={ui("公開プロフィールを見る", "View public profile")} referrerPolicy="origin">@{user.account_name}</a> : '@' + user.account_name}</span></div>
    <form className="bio-editor" onSubmit={async event => {
      event.preventDefault();
      setBioBusy(true); setBioStatus('');
      try {
        const saved = await request<{bio:string;bio_public:boolean}>('/account/profile/bio', {method:'PUT', body:{bio,bio_public:bioPublic}});
        setBio(saved.bio); onProfileSaved(saved); setBioStatus(ui("保存しました", "Saved"));
      } catch (cause) { setBioStatus(cause instanceof Error ? cause.message : ui("保存できませんでした。", "Could not save changes.")); }
      finally { setBioBusy(false); }
    }}>
      <div className="bio-heading">
        <label htmlFor="profile-bio">{ui("自己紹介", "Bio")}</label>
        <button type="submit" className="primary-button compact" disabled={!bioDirty || bioBusy || [...bio.trim()].length > 300}>{bioBusy ? ui("保存中…", "Saving…") : ui("保存", "Save")}</button>
      </div>
      <textarea id="profile-bio" aria-describedby="profile-bio-hint" value={bio} rows={3} disabled={bioBusy} onChange={e => {setBio(e.target.value); setBioStatus('');}} />
      <small id="profile-bio-hint">{ui("300文字まで。参加しているルームのプロフィールに表示されます。", "Up to 300 characters. Visible in your room profiles.")}</small>
      <label className="checkbox-label"><input type="checkbox" checked={bioPublic} disabled={bioBusy} onChange={e => { setBioPublic(e.target.checked); setBioStatus(''); }} />{ui("公開プロフィールにも表示", "Also show on my public profile")}</label>
      <span role="status">{bioStatus}</span>
    </form>
    <SocialLinkSettings />
    {imageSource(images, 'user', user.id) && <button className="text-button" disabled={removing} onClick={() => void remove()}>{ui("画像を削除", "Remove photo")}</button>}
    {error && <p className="form-error" role="alert">{error}</p>}
  </>;
}
