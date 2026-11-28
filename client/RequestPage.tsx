import { useEffect, useState } from 'react';
import { RequestBoard } from '../shared/RequestBoard';
import type { RequestPage as Page } from '../shared/room-requests';
import { directoryOrigin } from '../shared/directory';
import { locale, ui } from './language';
import { ScrollMore } from './ScrollPages';
import { followAppLink, navigateWithinApp } from './navigation';

export function RequestPage() {
  const {pathname,search,origin}=location;
  const suffix=pathname.slice('/requests'.length);
  const params=new URLSearchParams(search), query=params.get('query')??'';
  const [page,setPage]=useState<Page|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [attempt,setAttempt]=useState(0);
  useEffect(()=>{
    const controller=new AbortController();
    setError('');
    fetch('/api/explore/requests'+suffix+search,{signal:controller.signal}).then(async r=>{
      if(!r.ok)throw Error(r.status===404?ui('この依頼は公開されていません。','This request is unavailable.'):ui('読み込めませんでした。','Could not load requests.'));
      const result=await r.json() as Page;
      if(!controller.signal.aborted)setPage(result);
    }).catch(e=>{if(!controller.signal.aborted)setError(e.message);});
    return ()=>controller.abort();
  },[suffix,search,attempt]);
  async function more(){
    if(!page?.next_before||busy)return;
    setBusy(true);setError('');
    try {
      params.set('before',String(page.next_before));
      const r=await fetch('/api/explore/requests?'+params);
      if(!r.ok)throw Error(ui('続きを取得できませんでした。','Could not load more.'));
      const next=await r.json() as Page;
      setPage({...next,requests:[...page.requests,...next.requests]});
    } catch(e){setError(String(e));} finally{setBusy(false);}
  }
  return <div onClick={e=>{
    const a=e.target instanceof Element?e.target.closest('a'):null;
    if(a && a.origin===origin)followAppLink(e,a.href);
  }} onSubmit={e=>{
    if(!(e.target instanceof HTMLFormElement))return;
    e.preventDefault();
    const value=String(new FormData(e.target).get('query')??'').trim();
    navigateWithinApp('/requests'+(value?'?'+new URLSearchParams({query:value}):''));
  }}>
    {page && <RequestBoard page={page} detail={Boolean(suffix)} query={query} lang={locale} home={origin===directoryOrigin?'/':'/explore'}
      more={<ScrollMore key={page.next_before} load={()=>void more()} busy={busy}/>}/>}
    {!page && !error && <p role="status" className="request-board">{ui('読み込み中…','Loading…')}</p>}
    {error && <div className="request-board" role="alert">{error} <button className="text-button" onClick={()=>page?void more():setAttempt(v=>v+1)}>{ui('再試行','Retry')}</button> <a href="/requests">{ui('公開依頼','Open requests')}</a></div>}
  </div>;
}
