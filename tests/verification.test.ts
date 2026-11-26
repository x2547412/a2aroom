import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import { build } from 'esbuild';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { unstable_splitSqlQuery } from 'wrangler';
import type { VerificationNote, VerificationPage } from '../shared/verification';

test('verification notes follow room visibility, authorship, revision and block changes',async t=>{
  const origin='https://app.a2aroom.com';
  const bundled=await build({entryPoints:['server/index.ts'],write:false,bundle:true,format:'esm',platform:'browser',external:['cloudflare:*','node:*'],target:'es2022'});
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundled.outputFiles[0].text,d1Databases:['DB'],kvNamespaces:['OAUTH_KV'],
    compatibilityDate:'2026-11-19',compatibilityFlags:['nodejs_compat','global_fetch_strictly_public'],
    durableObjects:{PUSH:{className:'PushHub',useSQLite:true},DIRECTORY:{className:'DirectoryHub',useSQLite:true}},
    bindings:{ENVIRONMENT:'production',PUBLIC_ORIGIN:origin,DIRECTORY_ORIGIN:'https://a2aroom.com',OWNER_ACCOUNT:'owner',PRIVATE_BETA:'false',PUBLIC_ACCESS:'true'}}));
  t.after(()=>mf.dispose());
  const db=await mf.getD1Database('DB');
  for (const name of (await readdir('migrations')).sort()){
    await db.batch(unstable_splitSqlQuery(await readFile('migrations/'+name,'utf8')).map(s=>db.prepare(s)));
  }
  const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
  for (const id of ['owner','writer','peer','reader','guest']) {
    await db.prepare('INSERT INTO users(id,account_name,email,is_guest,created_at) VALUES(?,?,?,?,0)')
      .bind(id,id,id+'@example.invalid',Number(id==='guest')).run();
    if(id==='guest') continue;
    await db.prepare('INSERT INTO sessions VALUES(?,?,?,?,0)').bind(hash('session-'+id),id,'csrf',Date.now()+900000).run();
  }
  for (const [room,access,listed] of [['alpha','registered',1],['beta','anonymous',1],['private','invite',0],['unlisted','anonymous',0]] as const) {
    await db.prepare('INSERT INTO rooms(id,host_user_id,name,visibility,access_mode,directory_listed,created_at) VALUES(?,?,?,?,?,?,0)')
      .bind(room,'owner',room,access==='invite'?'invite':'public',access,listed).run();
    for (const user of ['writer','peer']) await db.prepare("INSERT INTO room_members(id,room_id,user_id,kind,joined_at) VALUES(?,?,?,'human',0)")
      .bind(room+'-'+user,room,user).run();
  }
  async function post(room:string,id:string,author='writer',reply:string|null=null,agent:string|null=null) {
    await db.prepare('INSERT INTO messages(id,room_id,author_user_id,author_agent_id,body,reply_to,created_at) VALUES(?,?,?,?,?,?,0)')
      .bind(id,room,author,agent,'Message '+id,reply).run();
  }
  const humanWrite=(room:string,id:string,change:unknown,user='writer')=>mf.dispatchFetch(origin+'/api/rooms/'+room+'/messages/'+id+'/note',{
    method:'PUT',headers:{Origin:origin,Cookie:'__Host-a2aroom_session=session-'+user,'X-CSRF-Token':'csrf','Content-Type':'application/json'},body:JSON.stringify(change)});
  const noteRead=async(room:string,id:string,user='reader')=>mf.dispatchFetch(origin+'/api/public/rooms/'+room+'/messages/'+id+'/note',{headers:{Cookie:'__Host-a2aroom_session=session-'+user}});
  const directory=async(query='',user='reader')=>await (await mf.dispatchFetch(origin+'/api/explore/verification'+query,{headers:{Cookie:'__Host-a2aroom_session=session-'+user}})).json() as VerificationPage;
  const evidence={kind:'evidence',source_url:'https://example.org/data',steps:'Measure the output twice'};
  for(const room of ['alpha','beta','private','unlisted']){
    await post(room,room);
    assert.equal((await humanWrite(room,room,evidence)).status,200);
  }
  assert.deepEqual((await directory()).notes.map(n=>n.room_id),['beta','alpha']);
  assert.equal((await humanWrite('alpha','alpha',evidence,'peer')).status,409);
  assert.equal((await humanWrite('alpha','alpha',{...evidence,source_url:'javascript:alert(1)'})).status,400);
  assert.equal((await noteRead('private','private')).status,404);
  assert.equal((await noteRead('alpha','alpha')).status,200);
  const read=async(viewer='reader')=>(await (await noteRead('alpha','alpha',viewer)).json()) as VerificationNote;
  const firstRevision=(await read()).revision;
  assert.equal((await humanWrite('alpha','alpha',{kind:'remove'})).status,200);
  assert.equal((await humanWrite('alpha','alpha',evidence)).status,200);
  const review={kind:'review',revision:(await read()).revision,status:'reproduced'};
  assert.notEqual(review.revision,firstRevision);
  assert.equal((await humanWrite('alpha','alpha',{...review,revision:firstRevision},'peer')).status,409);
  assert.equal((await humanWrite('alpha','alpha',review,'writer')).status,409);
  assert.equal((await humanWrite('alpha','alpha',review,'reader')).status,409);
  assert.equal((await humanWrite('alpha','alpha',review,'peer')).status,200);
  assert.equal((await read('peer')).reviews[0].mine,1);
  await db.prepare("INSERT INTO blocks VALUES('peer','reader',1)").run();
  assert.deepEqual((await read()).reviews,[]);
  await db.prepare("DELETE FROM blocks WHERE user_id='peer'").run();
  await post('alpha','fix','writer','alpha');
  await post('alpha','other','peer','alpha');
  assert.equal((await humanWrite('alpha','alpha',{kind:'correction',reply_id:'other'})).status,409);
  assert.equal((await humanWrite('alpha','alpha',{kind:'correction',reply_id:'fix'})).status,200);
  assert.equal((await read()).correction_body,'Message fix');
  assert.deepEqual((await read()).reviews,[]);
  assert.equal((await humanWrite('alpha','alpha',review,'peer')).status,409);
  const correctionRevision=(await read()).revision;
  assert.equal((await humanWrite('alpha','alpha',{...review,revision:correctionRevision},'peer')).status,200);
  await db.prepare("UPDATE messages SET edited_at=1,body='Corrected again' WHERE id='fix'").run();
  assert.deepEqual((await read()).reviews,[]);
  assert.notEqual((await read()).revision,correctionRevision);
  await db.prepare("UPDATE messages SET deleted_at=2 WHERE id='fix'").run();
  assert.equal((await read()).correction_id,null);
  await db.prepare("INSERT INTO blocks VALUES('writer','reader',1)").run();
  assert.equal((await noteRead('alpha','alpha')).status,404);
  assert.equal((await directory()).notes.length,0);
  await db.prepare("DELETE FROM blocks WHERE user_id='writer'").run();
  await db.prepare("INSERT INTO room_expulsions(room_id,user_id) VALUES('alpha','reader')").run();
  assert.deepEqual((await directory()).notes.map(n=>n.room_id),['beta']);
  await db.prepare("UPDATE rooms SET directory_listed=0 WHERE id='beta'").run();
  assert.equal((await directory()).notes.length,0);
  await db.prepare("DELETE FROM room_expulsions").run();
  assert.equal((await directory('?query=output')).notes.length,1);
  await db.prepare("UPDATE messages SET deleted_at=1 WHERE id='alpha'").run();
  assert.equal((await directory()).notes.length,0);
  // Anonymous authors can add evidence in their joined room. Their cookie cannot authorize other rooms.
  const guestToken='g'.repeat(43);
  await db.prepare("INSERT INTO guest_sessions(token_hash,room_id,user_id,csrf_token,expires_at,created_at) VALUES(?,'beta','guest','guest-csrf',?,0)")
    .bind(hash(guestToken),Date.now()+60_000).run();
  await db.prepare("INSERT INTO room_members(id,room_id,user_id,kind,joined_at) VALUES('guest-m','beta','guest','human',0)").run();
  await post('beta','g','guest');
  const guestWrite=(room:string)=>mf.dispatchFetch(origin+'/api/public/rooms/'+room+'/messages/g/note',{method:'PUT',headers:{
    Origin:origin,Cookie:'__Host-a2aroom_guest_beta='+guestToken,'X-CSRF-Token':'guest-csrf','Content-Type':'application/json'},body:JSON.stringify(evidence)});
  assert.equal((await guestWrite('beta')).status,200);
  assert.equal((await guestWrite('alpha')).status,401);
  await db.prepare("UPDATE rooms SET directory_listed=1 WHERE id='beta'").run();
  for (let i=0;i<21;i++){await post('alpha','archive-'+i);await humanWrite('alpha','archive-'+i,evidence);}
  const page=await directory('?query=archive');
  assert.equal(page.notes.length,20);
  assert.ok(page.next_before_seq);
  const more=await directory('?query=archive&before_seq='+page.next_before_seq);
  assert.equal(more.notes.length,1);
  assert.equal(new Set([...page.notes,...more.notes].map(n=>n.message_id)).size,21);
  assert.equal(more.next_before_seq,null);
  // The token is synthetic and only exists inside Miniflare.
  const token='a2a_'+ 'k'.repeat(43);
  await db.prepare("INSERT INTO agents(id,owner_id,name,handle,platform,created_at) VALUES('agent','writer','Reviewer','reviewer','test',0)").run();
  await db.prepare("INSERT INTO agent_connections(id,agent_id,label,kind,token_hash,created_at) VALUES('conn','agent','test','token',?,0)").bind(hash(token)).run();
  await db.prepare("INSERT INTO room_members(id,room_id,user_id,agent_id,kind,joined_at) VALUES('am','alpha','writer','agent','agent',0)").run();
  const call=async(name:string,args:Record<string,unknown>)=>{
    const res=await mf.dispatchFetch(origin+'/mcp',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});
    const rpc=await res.json() as {result:{isError?:boolean;content:{text:string}[]}};
    assert.equal(res.status,200);
    return rpc.result;
  };
  await post('alpha','ai','writer',null,'agent');
  assert.ok(!(await call('update_verification_note',{room_id:'alpha',message_id:'ai',change:evidence})).isError);
  assert.ok((await call('update_verification_note',{room_id:'alpha',message_id:'archive-0',change:evidence})).isError);
  const current=await call('get_verification_note',{room_id:'alpha',message_id:'archive-0'});
  assert.ok(!(await call('update_verification_note',{room_id:'alpha',message_id:'archive-0',change:{...review,revision:JSON.parse(current.content[0].text).revision}})).isError);
  const mcpNote=await call('get_verification_note',{room_id:'alpha',message_id:'archive-0'});
  assert.equal(JSON.parse(mcpNote.content[0].text).reviews[0].mine,1);
  assert.ok(!(await call('search_verification_archive',{query:'Measure'})).isError);
});
