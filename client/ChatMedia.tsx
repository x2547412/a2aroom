import { ui } from './language';
import { useEffect, useRef, useState } from 'react';
import { AtSign, Camera, ChevronRight, Download, FileText, Image as ImageIcon, Images, Paperclip, Smile, Video, X } from 'lucide-react';
import { reactions, stickers, type Attachment, type Reaction, type StickerId } from '../shared/chat';

export type MediaDraft = { files: File[]; sticker: StickerId | null; requestId: string };

export function chatPost(body: string, replyTo: string | null, media?: MediaDraft) {
  if (!media) return { path: '/messages', body: { body, reply_to: replyTo } };
  const form = new FormData();
  form.set('request_id', media.requestId);
  form.set('body', body);
  if (replyTo) form.set('reply_to', replyTo);
  if (media.sticker) form.set('sticker', media.sticker);
  for (const file of media.files) form.append('files', file);
  return { path: '/media-messages', body: form };
}

export function attachmentUrl(room: string, file: string, isPublic: boolean) {
  return (isPublic ? '/api/public' : '/api') + '/rooms/' + encodeURIComponent(room) + '/attachments/' + encodeURIComponent(file);
}

function readableSize(bytes: number) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return Math.ceil(bytes / 1024) + ' KB';
  return Number((bytes / (1024 * 1024)).toFixed(1)) + ' MB';
}

export function Sticker({ id }: { id: StickerId }) {
  const index = stickers.findIndex(sticker => sticker.id === id);
  if (index < 0) return null;
  return <span className="chat-sticker" role="img" aria-label={stickers[index].label}
    style={{ backgroundPosition: (index % 3) * 50 + '% ' + Math.floor(index / 3) * 100 + '%' }} />;
}

export function StickerPicker({ onSelect }: { onSelect: (id: StickerId) => void }) {
  return <div className="sticker-grid">{stickers.map(sticker =>
    <button type="button" key={sticker.id} onClick={() => onSelect(sticker.id)} aria-label={sticker.label}>
      <Sticker id={sticker.id} /><span aria-hidden="true">{sticker.label}</span>
    </button>)}</div>;
}

export function ReactionPicker({ current, busy, onChoose }: { current?: Reaction[]; busy: boolean; onChoose: (emoji: string | null) => void }) {
  return <div className="reaction-picker" role="group" aria-label={ui("リアクション", "Reactions")}>
    {reactions.map(({ emoji, label }) => {
      const active = Boolean(current?.some(reaction => reaction.mine && reaction.emoji === emoji));
      return <button type="button" key={emoji} aria-label={label} aria-pressed={active} disabled={busy}
        onClick={() => onChoose(active ? null : emoji)}>{emoji}</button>;
    })}
  </div>;
}

export function ReactionCounts({ items, onActions }: { items?: Reaction[]; onActions?: () => void }) {
  if (!items?.length) return null;
  return <div className="reaction-counts">{items.map(item => {
    const label = (reactions.find(r => r.emoji === item.emoji)?.label || item.emoji) + ' ' + item.count + ui("件", " items") + (item.mine ? ui("、あなたも選択中", ", selected by you") : '');
    const content = <><span aria-hidden="true">{item.emoji}</span>{item.count > 1 && <small>{item.count}</small>}</>;
    return onActions
      ? <button type="button" className={item.mine ? 'mine' : ''} key={item.emoji} aria-label={label} aria-haspopup="dialog" onClick={onActions}>{content}</button>
      : <span key={item.emoji} aria-label={label}>{content}</span>;
  })}</div>;
}

export function AttachmentSheet({ onFiles, onStickers, onMention, error }: {
  onFiles: (files: File[]) => void; onStickers: () => void; onMention?: () => void; error: string;
}) {
  const photos = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const videos = useRef<HTMLInputElement>(null);
  const documents = useRef<HTMLInputElement>(null);
  const select = (input: HTMLInputElement) => {
    const files = Array.from(input.files ?? []);
    input.value = '';
    if (files.length) onFiles(files);
  };
  return <div className="attachment-sheet">
    <input ref={photos} hidden type="file" accept="image/*,video/*" multiple onChange={e => select(e.currentTarget)} />
    <input ref={camera} hidden type="file" accept="image/*" capture="environment" onChange={e => select(e.currentTarget)} />
    <input ref={videos} hidden type="file" accept="video/*" multiple onChange={e => select(e.currentTarget)} />
    <input ref={documents} hidden type="file" multiple onChange={e => select(e.currentTarget)} />
    <div className="library-choices">
      <button type="button" className="camera-tile" onClick={() => camera.current?.click()}><Camera size={25} /><span>{ui("撮影", "Take photo")}</span></button>
      <button type="button" className="library-tile" onClick={() => photos.current?.click()}><Images size={25} /><span>{ui("写真ライブラリ", "Photo library")}</span><ChevronRight size={17} /></button>
    </div>
    <div className="attachment-options">
      <button type="button" onClick={() => documents.current?.click()}><Paperclip />{ui("ファイルを追加", "Add file")}<ChevronRight /></button>
      <button type="button" onClick={() => videos.current?.click()}><Video />{ui("動画を追加", "Add video")}<ChevronRight /></button>
      <button type="button" onClick={onStickers}><Smile />{ui("スタンプ", "Stickers")}<ChevronRight /></button>
      {onMention && <button type="button" onClick={onMention}><AtSign />{ui("メンション", "Mention")}<ChevronRight /></button>}
    </div>
    {error ? <p className="form-error" role="alert">{error}</p> : <p className="attachment-limit">{ui("1回に4件・合計25 MBまで", "Up to 4 files and 25 MB total")}</p>}
  </div>;
}

function DraftThumbnail({ file }: { file: File }) {
  const [url, setUrl] = useState('');
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false); setUrl('');
    if (!/^image\/(jpeg|png|gif|webp|avif|heic|heif)$/i.test(file.type) && !file.type.startsWith('video/')) return;
    const local = URL.createObjectURL(file);
    setUrl(local);
    return () => URL.revokeObjectURL(local);
  }, [file]);
  if (url && !failed) return file.type.startsWith('video/')
    ? <video src={url} muted playsInline preload="metadata" onError={() => setFailed(true)} />
    : <img src={url} alt="" onError={() => setFailed(true)} />;
  return file.type.startsWith('video/') ? <Video /> : file.type.startsWith('image/') ? <ImageIcon /> : <FileText />;
}

export function DraftTray({ files, sticker, disabled, onRemove, onRemoveSticker }: {
  files: File[]; sticker: StickerId | null; disabled: boolean; onRemove: (index: number) => void; onRemoveSticker: () => void;
}) {
  if (!files.length && !sticker) return null;
  return <div className="draft-tray" aria-label={ui("送信する添付", "Attachments to send")}>
    {sticker && <div className="draft-item draft-sticker"><Sticker id={sticker} /><button type="button" disabled={disabled} aria-label={ui("スタンプを外す", "Remove sticker")} onClick={onRemoveSticker}><X size={13} /></button></div>}
    {files.map((file, i) => <div className="draft-item" key={i}>
      <div className="draft-thumb"><DraftThumbnail file={file} /></div><span title={file.name}>{file.name}</span>
      <button type="button" disabled={disabled} aria-label={file.name + ui("を外す", " (remove)")} onClick={() => onRemove(i)}><X size={13} /></button>
    </div>)}
  </div>;
}

export function AttachmentView({ file, url, onPhoto }: { file: Attachment; url: string; onPhoto: () => void }) {
  const [failed, setFailed] = useState(false);
  if (file.kind === 'photo' && !failed) return <button type="button" className="sent-photo" aria-label={file.name + ui("を表示", " (view)")} onClick={onPhoto}>
    <img src={url} alt={file.name} loading="lazy" onError={() => setFailed(true)} /></button>;
  if (file.kind === 'video' && !failed) return <video className="sent-video" controls playsInline preload="metadata" aria-label={file.name} src={url} onError={() => setFailed(true)} />;
  return <a className="sent-file" href={url + '?download'} download={file.name}><FileText size={22} /><span><strong>{file.name}</strong><small>{readableSize(file.size)}</small></span><Download size={17} /></a>;
}
