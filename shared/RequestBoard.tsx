import { ArrowLeft, ArrowRight, ChevronRight, Search } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Language } from './language';
import { requestPath, type RequestPage } from './room-requests';

export function RequestBoard({lang, page, detail, query, more, home}:{
  lang:Language; page:RequestPage; detail:boolean; query:string; more?:ReactNode; home:string;
}) {
  const t=(ja:string,en:string)=>lang==='ja'?ja:en;
  const heading=t('公開依頼','Open requests');
  const item=detail?page.requests[0]:undefined;
  const next=new URLSearchParams({before:String(page.next_before)});
  if(query) next.set('query',query);
  return <main className="request-board">
    <a className="request-back" href={detail?'/requests':home}><ArrowLeft size={17}/>{detail?heading:t('公開ルーム','Public rooms')}</a>
    {item ? <article className="request-detail">
      <p className="request-meta">{item.room_name} · {item.status==='open'?t('受付中','Open'):t('解決済み','Resolved')}</p>
      <h1>{item.title}</h1>
      <p className="request-body">{item.body}</p>
      <dl>{item.environment && <><dt>{t('必要な環境','Environment')}</dt><dd>{item.environment}</dd></>}
        <dt>{t('返してほしい結果','Expected result')}</dt><dd>{item.expected_result}</dd></dl>
      <a className="outline-button compact" href={'/rooms/'+encodeURIComponent(item.room_id)+'?from=public&message='+encodeURIComponent(item.message_id)+'&seq='+item.message_seq}>
        {t('ルームで元の投稿を見る','View original post')}<ArrowRight size={16}/></a>
      <p className="request-meta">{item.guest_joinable?t('ゲストも参加できます','Guests can join'):t('返信には登録が必要です','Registration required to reply')}</p>
    </article> : <>
      <h1>{heading}</h1>
      <form className="discover-search" action="/requests" role="search"><Search size={18}/>
        <input type="search" name="query" maxLength={120} defaultValue={query} aria-label={t('依頼を検索','Search requests')} placeholder={t('内容や必要な環境で検索','Search by topic or environment')}/></form>
      {page.requests.length ? <ul className="request-list">{page.requests.map(r=><li key={r.message_id}><a href={requestPath(r.message_id)}>
        <div><span className="request-meta">{r.room_name}</span><h2>{r.title}</h2><p>{r.expected_result}</p>
          {r.environment && <small>{r.environment}</small>}</div><ChevronRight size={18}/></a></li>)}</ul>
        : <p className="request-empty">{query?t('条件に合う依頼はありません。','No matching requests.'):t('受付中の依頼はありません。','There are no open requests.')}</p>}
      {page.next_before && (more ?? <a href={'/requests?'+next}>{t('続きを表示','Next page')}</a>)}
    </>}
  </main>;
}
