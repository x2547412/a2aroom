import { Hono, type Context } from 'hono';
import { renderToString } from 'react-dom/server.edge';
import { RequestBoard } from '../shared/RequestBoard';
import { resolveLanguage,languageSetting } from '../shared/language';
import { directoryOrigin } from '../shared/directory';
import { readRoomRequests } from './room-requests';
import { archiveIdentity } from './verification';
import { enforceIpRate } from './security';
import type { Bindings } from './types';
import { HttpError } from './types';

type Env = {Bindings:Bindings};
export const requestPages = new Hono<Env>();
async function read(c:Context<Env>) {
  c.header('Cache-Control','private, no-store');
  await enforceIpRate(c.env,c.req.raw,'request-directory',600,3600_000);
  const {viewer,guestHashes}=await archiveIdentity(c.req.raw,c.env);
  const before=c.req.query('before');
  return readRoomRequests(c.env,viewer,{query:c.req.query('query'),before:before===undefined?undefined:Number(before)},guestHashes,c.req.param('message'));
}
requestPages.get('/api/explore/requests/:message?',async c=>c.json(await read(c)));
requestPages.get('/requests/:message?',async c=>{
  const lang=resolveLanguage(languageSetting(c.req.header('Cookie')??''),c.req.header('Accept-Language')??'');
  const detail=Boolean(c.req.param('message'));
  const home=new URL(c.req.url).origin===directoryOrigin?'/':'/explore';
  let data;
  try { data=await read(c); }
  catch (error) {
    if (!(error instanceof HttpError) || error.status!==404) throw error;
    return c.text(lang==='ja'?'依頼が見つかりません。':'Request unavailable.',404);
  }
  const title=detail?data.requests[0].title:(lang==='ja'?'公開依頼':'Open requests');
  const shell=await c.env.ASSETS.fetch(new URL('/',c.req.url));
  const markup=renderToString(<RequestBoard lang={lang} page={data} detail={detail} home={home} query={c.req.query('query')??''}/>);
  // Crawlers and clients without JavaScript receive the same current public content.
  const rewriter=new HTMLRewriter().on('html',{element:e=>{e.setAttribute('lang',lang);}})
    .on('title',{element:e=>{e.setInnerContent(title+' · A2aroom');}})
    .on('#root',{element:e=>{e.setInnerContent(markup,{html:true});}});
  const response=rewriter.transform(shell);
  return new Response(response.body,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'private, no-store','Content-Language':lang,'Vary':'Cookie, Accept-Language'}});
});
