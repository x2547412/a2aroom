import { useEffect, useRef, useState } from 'react';
import { BookOpenCheck, ChevronLeft, ChevronRight, Link as LinkIcon, Paperclip, Search, X } from 'lucide-react';
import { verdicts, type VerificationNote, type VerificationPage, type Verdict } from '../shared/verification';
import { directoryRoomPath } from '../shared/directory';
import { publicRequest, request, type Message } from './api';
import { locale, ui } from './language';
import { Modal } from './Modal';
import { ScrollMore } from './ScrollPages';
import { attachmentUrl } from './ChatMedia';
import { followAppLink } from './navigation';
import './verification.css';

export const noteLabel = ui('検証ノート','Verification note');
export const archiveLabel = ui('検証アーカイブ','Verification archive');
const verdictLabels:Record<Verdict,string> = {
  verified:ui('検証済み','Verified'), reproduced:ui('再現済み','Reproduced'), disputed:ui('異議あり','Disputed'),
};

function NoteContents({note,publicView}:{note:VerificationNote;publicView:boolean}) {
  return <div className="verification-contents">
    {note.source_url && <a href={note.source_url} target="_blank" rel="noopener noreferrer ugc"><LinkIcon size={15}/>{note.source_url}</a>}
    {note.files.map(file => <a key={file.id} href={attachmentUrl(note.room_id,file.id,publicView)+'?download'} download={file.name}><Paperclip size={15}/>{file.name}</a>)}
    {note.steps && <section><h3>{ui('再現手順','Reproduction steps')}</h3><p>{note.steps}</p></section>}
    {note.correction_id && <section><h3>{ui('投稿者による訂正','Author correction')}</h3><p>{note.correction_body}</p></section>}
    {note.reviews.length>0 && <ul className="verification-verdicts" aria-label={ui('査読結果','Reviews')}>
      {note.reviews.map(review=><li key={review.status}>{verdictLabels[review.status]} · {review.count}</li>)}</ul>}
  </div>;
}

type NoteProps = {
  message:Message; userId:string; publicView:boolean; csrf?:string; canSend:boolean; listed:boolean;
  onClose:()=>void; onChange:()=>void;
};
export function VerificationDialog({message,userId,publicView,csrf,canSend,listed,onClose,onChange}:NoteProps) {
  const own=message.author_user_id===userId && !message.author_agent_id;
  const path='/rooms/'+encodeURIComponent(message.room_id)+'/messages/'+encodeURIComponent(message.id)+'/note';
  const [note,setNote]=useState<VerificationNote|null>(null), [url,setUrl]=useState(''), [steps,setSteps]=useState('');
  const [loaded,setLoaded]=useState(!message.has_note), [busy,setBusy]=useState(false), [error,setError]=useState(''), [attempt,setAttempt]=useState(0);
  useEffect(()=>{
    if (!message.has_note) return;
    let active=true;
    (publicView ? publicRequest : request)<VerificationNote>(path).then(data=>{
      if (active) {setNote(data); setUrl(data.source_url); setSteps(data.steps); setLoaded(true); setError('');}
    }).catch(e=>{if(active)setError(e.message);});
    return ()=>{active=false;};
  },[path,publicView,message.has_note,attempt]);
  async function save(change:Record<string,unknown>) {
    setBusy(true);setError('');
    try {
      const options={method:'PUT',body:change,csrf};
      await (publicView?publicRequest:request)(path,options);
      onChange();onClose();
    } catch(e) {setError(e instanceof Error ? e.message : ui('保存できませんでした。','Could not save.'));}
    finally {setBusy(false);}
  }
  return <Modal title={noteLabel} onClose={onClose} closeDisabled={busy}>
    <div className="verification-detail">
      <blockquote>{message.body}</blockquote>
      {loaded && own && canSend ? <form className="modal-form" onSubmit={e=>{e.preventDefault();void save({kind:'evidence',source_url:url.trim(),steps:steps.trim()});}}>
        <label>{ui('根拠のリンク','Source URL')}<input type="url" value={url} onChange={e=>setUrl(e.target.value)} maxLength={2048} placeholder="https://"/></label>
        <label>{ui('再現手順','Reproduction steps')}<textarea rows={4} value={steps} onChange={e=>setSteps(e.target.value)} maxLength={2000}/></label>
        {Boolean(message.attachments?.length) && <small>{ui('この投稿の添付も根拠に含まれます。','Attachments on this message are included as evidence.')}</small>}
        {listed && <small>{ui('このノートは公開アーカイブに掲載されます。','This note will appear in the public archive.')}</small>}
        <button className="primary-button" disabled={busy||!(url.trim()||steps.trim()||message.attachments?.length)}>{ui('保存','Save')}</button>
      </form> : note && <NoteContents note={note} publicView={publicView}/>}
      {note && own && canSend && <>
        {note.correction_id && <p>{ui('投稿者による訂正','Author correction')} · {note.correction_body}</p>}
        <small>{ui('訂正するには、この投稿に返信し、その返信の操作から「元のノートの訂正にする」を選びます。','To correct this note, reply to its message and choose “Mark as correction” on your reply.')}</small>
        <div className="verification-controls">{note.correction_id && <button className="text-button" disabled={busy} onClick={()=>void save({kind:'correction',reply_id:null})}>{ui('訂正リンクを解除','Unlink correction')}</button>}
          <button className="text-button destructive" disabled={busy} onClick={()=>{if(window.confirm(ui('この検証ノートと査読結果を削除しますか？','Remove this note and its reviews?')))void save({kind:'remove'});}}>{ui('ノートを削除','Remove note')}</button></div>
        {note.reviews.map(r=><small key={r.status}>{verdictLabels[r.status]} · {r.count} </small>)}
      </>}
      {note && canSend && !own && <fieldset disabled={busy} className="verification-controls"><legend>{ui('自分の査読結果','Your review')}</legend>
        {verdicts.map(status=>{const mine=Boolean(note.reviews.find(r=>r.status===status)?.mine);
          return <button type="button" className="outline-button compact" aria-pressed={mine} key={status} onClick={()=>void save({kind:'review',status:mine?null:status,revision:note.revision})}>{verdictLabels[status]}</button>;
        })}</fieldset>}
      {!loaded && !error && <p role="status">{ui('読み込み中…','Loading…')}</p>}
      {error && <p role="alert">{error} {!loaded && <button className="text-button" onClick={()=>setAttempt(n=>n+1)}>{ui('再試行','Retry')}</button>}</p>}
    </div>
  </Modal>;
}

export function VerificationArchive({onBack}:{onBack:()=>void}) {
  const [search,setSearch]=useState(''),[query,setQuery]=useState(''),[attempt,setAttempt]=useState(0);
  const [page,setPage]=useState<VerificationPage|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const active=useRef<AbortController|null>(null);
  useEffect(()=>{const id=setTimeout(()=>setQuery(search.trim()),200);return ()=>clearTimeout(id);},[search]);
  async function load(text:string, before:number|null) {
    active.current?.abort();
    const controller=new AbortController();active.current=controller;
    setBusy(true);setError('');
    try {
      const params=new URLSearchParams({query:text});if(before!==null)params.set('before_seq',String(before));
      const res=await fetch('/api/explore/verification?'+params,{signal:controller.signal,cache:'no-store'});
      if(!res.ok)throw new Error(ui('ノートを取得できませんでした。','Could not load notes.'));
      const next=await res.json() as VerificationPage;
      if(!controller.signal.aborted)setPage(prev=>({...next,notes:before===null?next.notes:[...(prev?.notes??[]),...next.notes]}));
    } catch(e){if(!controller.signal.aborted)setError(e instanceof Error ? e.message : ui('取得できませんでした。','Could not load.'));}
    finally {if(!controller.signal.aborted)setBusy(false);}
  }
  useEffect(()=>{setPage(null);void load(query,null);return ()=>active.current?.abort();},[query,attempt]);
  const searchInput = useRef<HTMLInputElement>(null);
  const searchLabel = ui('検証ノートを検索', 'Search verification notes');
  const backLabel = ui('公開ルーム', 'Public rooms');
  return <main className="discovery verification-archive">
    <header className="archive-heading">
      <button type="button" className="toolbar-button" aria-label={backLabel} title={backLabel} onClick={onBack}>
        <ChevronLeft size={24} aria-hidden="true" />
      </button>
      <h1>{archiveLabel}</h1>
    </header>
    <div className="discover-search">
      <Search size={18} aria-hidden="true" />
      <input ref={searchInput} type="search" aria-label={searchLabel} placeholder={searchLabel}
        maxLength={120} value={search} onChange={e => setSearch(e.target.value)} />
      {search && <button type="button" className="icon-button" aria-label={ui('検索をクリア', 'Clear search')}
        onClick={() => { setSearch(''); searchInput.current?.focus(); }}><X size={16} aria-hidden="true" /></button>}
    </div>
    {!!page?.notes.length && <ul className="verification-entries">
      {page.notes.map(note => {
        const roomPath = directoryRoomPath(note.room_id, 'public');
        const date = new Date(note.created_at);
        return <li key={note.message_id}>
          <header className="archive-note-header">
            <a href={roomPath} onClick={e => followAppLink(e, roomPath)}>
              {note.room_name}<ChevronRight size={15} aria-hidden="true" />
            </a>
            <div className="archive-byline">
              <strong>{note.author}</strong>
              <time dateTime={date.toISOString()}>{date.toLocaleDateString(locale)}</time>
            </div>
          </header>
          {note.body && <p className="archive-note-body">{note.body}</p>}
          <NoteContents note={note} publicView />
        </li>;
      })}
    </ul>}
    {page && !page.notes.length && !error && !busy && <div className="archive-empty" role="status">
      <span className="archive-empty-icon" aria-hidden="true">{query ? <Search size={28} /> : <BookOpenCheck size={28} />}</span>
      <h2>{query ? ui('検索結果はありません', 'No matching notes') : ui('検証ノートはまだありません', 'No verification notes yet')}</h2>
      <p>{query ? ui('別のキーワードで検索してみてください。', 'Try a different keyword.')
        : ui('公開ルームの投稿に検証ノートを追加すると、ここに表示されます。', 'Notes added to posts in listed public rooms appear here.')}</p>
    </div>}
    {error ? <div className="discovery-state" role="alert"><p>{error}</p>
      <button type="button" className="outline-button compact" onClick={() => page?.next_before_seq ? void load(query,page.next_before_seq) : setAttempt(n=>n+1)}>{ui('再試行', 'Retry')}</button></div>
      : busy ? <p className="discovery-state" role="status">{ui('読み込み中…','Loading…')}</p>
      : page?.next_before_seq && <ScrollMore key={page.next_before_seq} load={()=>void load(query,page.next_before_seq)}/>}
  </main>;
}
