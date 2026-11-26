import { ui } from './language';
import { request } from './api';
import { useEffect, useId, useRef, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { isValidTag, maxTagLength, maxTags, splitTags } from '../shared/directory';

const fallbackTags = [
  ui('雑談', 'Chat'), 'AI', ui('開発', 'Development'), ui('勉強', 'Learning'), ui('趣味', 'Hobbies'),
];

type SaveTags = (operation: 'add' | 'remove', labels: string[]) => Promise<void>;

export function useRoomTags(saved?: string[], save?: SaveTags) {
  const [local, setLocal] = useState<string[]>([]);
  const tags = saved ?? local;
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState('');
  const values = splitTags([...tags, draft].join(' '));
  const error = values.length > maxTags ? ui(`タグは${maxTags}個まで設定できます。`, `Add up to ${maxTags} tags.`) :
    values.some(tag => !isValidTag(tag)) ? ui(`タグは記号の # を含まない${maxTagLength}文字以内で入力してください。`, `Use up to ${maxTagLength} characters per tag and omit #.`) : '';

  async function change(operation: 'add' | 'remove', labels: string[], clearDraft = false) {
    if (busy || (operation === 'add' && error)) return;
    try {
      setSaveError('');
      if (save && labels.length) {
        setBusy(true);
        await save(operation, labels);
      } else if (!save) {
        setLocal(current => operation === 'add' ? splitTags([...current, ...labels].join(' ')) : current.filter(tag => !labels.includes(tag)));
      }
      if (clearDraft) setDraft('');
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : ui("タグを保存できませんでした。", "Could not save tags."));
    } finally { setBusy(false); }
  }
  return { addSuggestion: (tag: string) => change('add', [tag]), tags, draft, setDraft, values, error, saveError, busy,
    commit: () => change('add', values.filter(tag => !tags.includes(tag)), true),
    remove: (tag: string) => change('remove', [tag]) };
}

export function RoomTags({ field }: { field: ReturnType<typeof useRoomTags> }) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [popular, setPopular] = useState<string[]>([]);
  useEffect(() => {
    let active = true;
    request<{ tags: string[] }>('/directory/popular-tags')
      .then(({ tags }) => { if (active) setPopular(tags); })
      .catch(error => console.warn('Could not load popular room tags.', error));
    return () => { active = false; };
  }, []);
  const used = new Set(field.values.map(tag => tag.toLowerCase()));
  const suggestions = used.size >= maxTags ? [] : splitTags([...popular, ...fallbackTags].join(' '))
    .filter(tag => !used.has(tag.toLowerCase())).slice(0, maxTags);
  return <div className="room-tags">
    <label htmlFor={id}>{ui("タグ", "Tags")} <span className="optional">{ui("任意", "Optional")}</span></label>
    <div className="tag-editor">
      {field.tags.map(tag => <span key={tag} className="tag-chip">{tag}
        <button type="button" disabled={field.busy} aria-label={ui(`${tag}を削除`, `Remove ${tag}`)} onClick={() => { field.remove(tag); input.current?.focus(); }}><X size={14}/></button>
      </span>)}
      <div className="tag-entry">
        <input id={id} ref={input} name="tags" readOnly={field.busy} value={field.draft} placeholder={ui("タグを入力", "Enter a tag")} enterKeyHint="done" autoComplete="off"
          aria-invalid={Boolean(field.error)} aria-describedby={id + '-hint'} onChange={event => field.setDraft(event.target.value)}
          onKeyDown={event => {
            if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
            event.preventDefault();
            field.commit();
          }}/>
        {field.draft.trim() && <button type="button" aria-label={ui("タグを追加", "Add tag")} disabled={field.busy || Boolean(field.error)} onClick={() => { field.commit(); input.current?.focus(); }}><Plus size={18}/></button>}
      </div>
    </div>
    {suggestions.length > 0 && <div className="tag-suggestions" role="group" aria-labelledby={id + '-suggestions'}>
      <span id={id + '-suggestions'}>{ui('おすすめ', 'Suggested')}</span>
      {suggestions.map(tag => <button key={tag} type="button" disabled={field.busy || Boolean(field.error)}
        onClick={() => field.addSuggestion(tag)}><span aria-hidden="true">#</span>{tag}</button>)}
    </div>}
    {field.saveError && <p className="form-error" role="alert">{field.saveError}</p>}
    <small id={id + '-hint'} className={field.error ? 'form-error' : ''}>{field.busy ? ui("保存中…", "Saving…") : field.error || ui(`スペースか読点で区切って${maxTags}個まで。`, `Separate up to ${maxTags} tags with spaces or commas.`)}</small>
  </div>;
}
