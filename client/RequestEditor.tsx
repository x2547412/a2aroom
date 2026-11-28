import { useEffect,useState } from 'react';
import { Modal } from './Modal';
import { publicRequest,request,type Message } from './api';
import type { RequestPage } from '../shared/room-requests';
import { ui } from './language';

export function RequestEditor({message,guest,csrf,onSaved,onClose}:{
  message:Message;guest:boolean;csrf?:string;onSaved:()=>void;onClose:()=>void;
}) {
  const [title,setTitle]=useState(''),[environment,setEnvironment]=useState(''),[result,setResult]=useState('');
  const [loaded,setLoaded]=useState(!message.request_status),[busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{
    if(!message.request_status)return;
    const controller=new AbortController();
    fetch('/api/explore/requests/'+encodeURIComponent(message.id),{signal:controller.signal}).then(async r=>{
      if(!r.ok)throw Error(ui('依頼を読み込めませんでした。','Could not load the request.'));
      const item=((await r.json()) as RequestPage).requests[0];
      if(controller.signal.aborted)return;
      setTitle(item.title);setEnvironment(item.environment);setResult(item.expected_result);setLoaded(true);
    }).catch(e=>{if(!controller.signal.aborted)setError(e.message);});
    return ()=>controller.abort();
  },[message.id,message.request_status]);
  async function save(action:'publish'|'withdraw'|'resolve'|'reopen'){
    setBusy(true);setError('');
    try{
      await (guest?publicRequest:request)('/rooms/'+message.room_id+'/messages/'+message.id+'/request',{
        method:'PUT',csrf,body:action==='publish'?{action,title,environment,expected_result:result}:{action}});
      onSaved();onClose();
    }catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}
  }
  return <Modal title={message.request_status?ui('依頼を編集','Edit request'):ui('依頼を公開','Publish request')} onClose={onClose} closeDisabled={busy}>
    <form className="modal-form" onSubmit={e=>{e.preventDefault();void save('publish');}}>
      <p className="muted">{ui('この投稿と以下の内容が公開依頼の一覧に表示されます。','This post and the details below will appear on the public request board.')}</p>
      <label>{ui('依頼のタイトル','Request title')}<input disabled={!loaded||busy} value={title} maxLength={120} required onChange={e=>setTitle(e.target.value)}/></label>
      <label>{ui('必要な環境（任意）','Environment (optional)')}<input disabled={!loaded||busy} value={environment} maxLength={200} onChange={e=>setEnvironment(e.target.value)}/></label>
      <label>{ui('返してほしい結果','Expected result')}<textarea disabled={!loaded||busy} value={result} maxLength={500} required rows={3} onChange={e=>setResult(e.target.value)}/></label>
      {error && <p role="alert">{error}</p>}
      <div className="request-controls"><button className="primary-button" disabled={!loaded||busy||!title.trim()||!result.trim()}>{message.request_status?ui('保存','Save'):ui('公開する','Publish')}</button>
      {message.request_status && <><button type="button" className="outline-button" disabled={!loaded||busy} onClick={()=>void save(message.request_status==='open'?'resolve':'reopen')}>{message.request_status==='open'?ui('解決済みにする','Mark resolved'):ui('受付を再開','Reopen')}</button>
      <button type="button" className="text-button" disabled={!loaded||busy} onClick={()=>void save('withdraw')}>{ui('掲載を取り下げる','Withdraw request')}</button></>}</div>
    </form>
  </Modal>;
}
