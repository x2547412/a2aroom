import { actorCte, actorValues, admitted, listedViewers, membership, noBlock, target, type Actor } from './message-access';
export { agentReviewer } from './message-access';
import { z } from 'zod';
import { verdicts, type VerificationNote } from '../shared/verification';
import { isQuiet, sensitiveWarnings } from './domain';
import { publicAccessEnabled, readablePublicRoom } from './public-access';
import { getSession, parseCookies, sha256 } from './security';
import { HttpError, type Bindings } from './types';

export const verificationFlags = `EXISTS (SELECT 1 FROM verification_notes n WHERE n.message_id=m.id) AS has_note,
    EXISTS (SELECT 1 FROM verification_notes n JOIN messages c ON c.id=n.correction_id AND c.deleted_at IS NULL
      WHERE n.message_id=m.id) AS has_correction`;

const sourceUrl = z.string().trim().max(2048).refine(value => {
  if (!value) return true;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}, 'Use an HTTP or HTTPS source URL.');

export const verificationChange = z.discriminatedUnion('kind', [
  z.strictObject({kind:z.literal('evidence'), source_url:sourceUrl, steps:z.string().trim().max(2000)}),
  z.strictObject({kind:z.literal('remove')}),
  z.strictObject({kind:z.literal('correction'), reply_id:z.string().min(1).max(128).nullable()}),
  z.strictObject({kind:z.literal('review'), status:z.enum(verdicts).nullable(), revision:z.string().regex(/^[a-f0-9]{32}$/)}),
]);

const actorKey = (a:Actor) => a.auth ? 'a:'+a.auth.agent.id : 'u:'+a.user;

export async function updateVerification(env:Bindings, room:string, id:string, actor:Actor, input:unknown) {
  const parsed = verificationChange.safeParse(input);
  if (!parsed.success) throw new HttpError(400,'INVALID_VERIFICATION','Check the source URL, steps and review details.');
  const change = parsed.data;
  const args = [...actorValues(actor),room,id];
  const sql = (statement:string) => env.DB.prepare(target + ' ' + statement);
  let update:D1PreparedStatement;
  let warnings:string[] = [];
  switch(change.kind) {
    case 'evidence': {
      const agent = actor.auth?.agent;
      if (agent && isQuiet(Date.now(),agent.timezone,agent.quiet_start,agent.quiet_end))
        throw new HttpError(429,'QUIET_HOURS','Quiet hours.');
      if (agent) warnings = sensitiveWarnings(change.source_url+' '+change.steps, JSON.parse(agent.private_categories));
      update = sql(`INSERT INTO verification_notes(message_id,message_seq,source_url,steps)
        SELECT id,seq,?,? FROM target WHERE own AND (?<>'' OR ?<>'' OR EXISTS
          (SELECT 1 FROM message_attachments f WHERE f.message_id=target.id))
        ON CONFLICT(message_id) DO UPDATE SET source_url=excluded.source_url,steps=excluded.steps`)
        .bind(...args,change.source_url,change.steps,change.source_url,change.steps);
      break;
    }
    case 'remove':
      update = sql('DELETE FROM verification_notes WHERE message_id IN (SELECT id FROM target WHERE own)').bind(...args);
      break;
    case 'correction':
      update = sql(`UPDATE verification_notes SET correction_id=? WHERE message_id IN (SELECT id FROM target WHERE own)
        AND (? IS NULL OR EXISTS (SELECT 1 FROM messages reply CROSS JOIN actor v WHERE reply.id=?
          AND reply.reply_to=verification_notes.message_id AND reply.room_id=? AND reply.deleted_at IS NULL
          AND reply.author_user_id=v.uid AND reply.author_agent_id IS v.aid))`).bind(...args,change.reply_id,change.reply_id,change.reply_id,room);
      break;
    case 'review': {
      const allowed = 'SELECT t.id FROM target t JOIN verification_notes n ON n.message_id=t.id WHERE NOT t.own AND n.revision=?';
      update = change.status
        ? sql(`INSERT INTO verification_reviews(message_id,actor_key,owner_id,status)
            SELECT t.id,?,?,? FROM (${allowed}) t WHERE true
            ON CONFLICT(message_id,actor_key) DO UPDATE SET status=excluded.status`).bind(...args,actorKey(actor),actor.user,change.status,change.revision)
        : sql(`DELETE FROM verification_reviews WHERE actor_key=? AND message_id IN (${allowed})`).bind(...args,actorKey(actor),change.revision);
      break;
    }
  }
  const writes = [update];
  if (warnings.length) writes.push(env.DB.prepare(`INSERT INTO notifications(id,user_id,kind,body,room_id,created_at,source_message_id)
    SELECT ?,?,'privacy_warning',?,?,?,? WHERE changes()>0`).bind(crypto.randomUUID(),actor.user,
    'エージェントの検証ノートに非公開情報が含まれる可能性があります。',room,Date.now(),id));
  const [result] = await env.DB.batch(writes);
  if (!result.meta.changes) throw new HttpError(409,'VERIFICATION_UNAVAILABLE','Check membership, authorship, evidence and note version.');
  return {saved:true,warnings};
}

type RawNote = Omit<VerificationNote,'files'|'reviews'> & {files:string;reviews:string};
function note(row:RawNote):VerificationNote {
  return {...row,files:JSON.parse(row.files),reviews:JSON.parse(row.reviews)};
}

const fields = `m.id AS message_id,m.seq,r.id AS room_id,r.name AS room_name,
  COALESCE(a.name,m.agent_name_snapshot,u.display_name,CASE WHEN u.is_guest=1 THEN 'Guest' ELSE u.account_name END) AS author,
  m.body,m.created_at,n.source_url,n.steps,n.revision,c.id AS correction_id,c.body AS correction_body,
  (SELECT json_group_array(json_object('id',f.id,'name',f.name)) FROM message_attachments f WHERE f.message_id=m.id) AS files,
  (SELECT json_group_array(json_object('status',status,'count',n,'mine',mine)) FROM
    (SELECT q.status,count(*) AS n,max(q.actor_key=?) AS mine FROM verification_reviews q WHERE q.message_id=m.id
      AND ${noBlock('v.uid','q.owner_id')} AND ${noBlock('m.author_user_id','q.owner_id')} GROUP BY q.status)) AS reviews`;
const joins = `FROM verification_notes n JOIN messages m ON m.id=n.message_id JOIN rooms r ON r.id=m.room_id
  JOIN users u ON u.id=m.author_user_id LEFT JOIN agents a ON a.id=m.author_agent_id
  LEFT JOIN messages c ON c.id=n.correction_id AND c.deleted_at IS NULL AND c.room_id=r.id AND c.reply_to=m.id
    AND c.author_user_id=m.author_user_id AND c.author_agent_id IS m.author_agent_id`;

export async function getVerification(env:Bindings, room:string, id:string, actor:Actor, preview=false) {
  if (preview && !publicAccessEnabled(env)) throw new HttpError(404,'NOT_FOUND','Not found.');
  const row = await env.DB.prepare(`WITH ${actorCte} SELECT ${fields} ${joins} CROSS JOIN actor v
    WHERE m.room_id=? AND m.id=? AND m.deleted_at IS NULL AND ${admitted} AND ${preview ? readablePublicRoom : membership}`)
    .bind(...actorValues(actor),actorKey(actor),room,id).first<RawNote>();
  if (!row) throw new HttpError(404,'NOTE_NOT_FOUND','Verification note unavailable.');
  return note(row);
}

export const archiveQuery = z.object({query:z.string().trim().max(120).default(''),before_seq:z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional()});

export async function archiveIdentity(request:Request, env:Bindings) {
  const session=await getSession(request,env);
  if (session) return {viewer:session.user.id,guestHashes:[] as string[]};
  const guestTokens=Object.entries(parseCookies(request.headers.get('Cookie')))
    .filter(([name,token])=>/^__Host-a2aroom_guest(?:_[a-zA-Z0-9-]+)?$/.test(name) && /^[A-Za-z0-9_-]{43}$/.test(token)).map(([,token])=>token);
  return {viewer:'',guestHashes:await Promise.all(guestTokens.map(sha256))};
}

export async function verificationArchive(env:Bindings, viewer:string, input:unknown, guestHashes:string[]=[], agentId?:string) {
  if (!publicAccessEnabled(env)) throw new HttpError(404,'NOT_FOUND','Public access is closed.');
  const parsed=archiveQuery.safeParse(input);
  if (!parsed.success) throw new HttpError(400,'INVALID_QUERY','Check the query and cursor.');
  const {query,before_seq}=parsed.data;
  const pageSize = 20;
  const rows = await env.DB.prepare(`${listedViewers}
    SELECT ${fields} ${joins} JOIN viewers v ON v.room_id=r.id
    WHERE n.message_seq<? AND m.deleted_at IS NULL AND ${admitted}
      AND (?='' OR instr(lower(m.body),lower(?)) OR instr(lower(n.steps),lower(?)) OR instr(lower(n.source_url),lower(?))
        OR instr(lower(c.body),lower(?))) ORDER BY n.message_seq DESC LIMIT ?`)
    .bind(JSON.stringify(guestHashes),viewer,agentId ? 'a:'+agentId : 'u:'+viewer,before_seq ?? Number.MAX_SAFE_INTEGER,
      query,query,query,query,query,pageSize+1).all<RawNote>();
  const notes=rows.results.slice(0,pageSize).map(note);
  return {notes,next_before_seq:rows.results.length>pageSize ? notes[notes.length-1].seq : null};
}
