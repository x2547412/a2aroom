import { ui } from './language';
import { useRef, useState, type FormEvent } from 'react';
import { Modal } from './Modal';
import { Pencil } from 'lucide-react';

export function EditableName({ name, onSave, label = ui("表示名", "Display name"), editLabel = ui("表示名を変更", "Edit display name"), maxLength = 40, dialog = false, as: Tag = 'h1' }: { label?: string; editLabel?: string; maxLength?: number; dialog?: boolean; as?: 'strong' | 'h1'; name: string; onSave: (name: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false), [draft, setDraft] = useState(name);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  async function save(e: FormEvent) {
    e.preventDefault(); const next = draft.trim();
    if (busy || !next) return;
    setBusy(true); setError('');
    try { await onSave(next); setEditing(false); }
    catch (cause) { setError(cause instanceof Error ? cause.message : ui("名前を保存できませんでした。", "Could not save the name.")); }
    finally { setBusy(false); }
  }
  const form = <form className={dialog ? "modal-form" : "edit-agent-name"} onSubmit={save}>
    <label>{label}<input name="name" ref={input} autoFocus={!dialog} required maxLength={maxLength} value={draft} onChange={e => setDraft(e.target.value)} /></label>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="dialog-actions"><button type="button" className={dialog ? "outline-button compact" : "text-button"} disabled={busy} onClick={() => setEditing(false)}>{ui("キャンセル", "Cancel")}</button>
      <button className="primary-button compact" disabled={busy || !draft.trim()}>{busy ? ui("保存中…", "Saving…") : ui("保存", "Save")}</button></div>
  </form>;
  if (editing && !dialog) return form;
  return <><div className="agent-name-line"><Tag>{name}</Tag><button type="button" className="icon-button" aria-label={editLabel} onClick={() => { setDraft(name); setError(''); setEditing(true); }}><Pencil size={17} /></button></div>
    {editing && <Modal title={editLabel} initialFocus={input} closeDisabled={busy} onClose={() => setEditing(false)}>{form}</Modal>}
  </>;
}
