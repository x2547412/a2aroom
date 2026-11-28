import { isQuiet, sensitiveWarnings } from './domain';
import { z } from 'zod';
import { requestPath, type RoomRequest } from '../shared/room-requests';
import { actorValues, admitted, listedViewers, target, type Actor } from './message-access';
import { publicAccessEnabled, readablePublicRoom } from './public-access';
import { HttpError, type Bindings } from './types';

export const requestQuery = z.object({
  query: z.string().trim().max(120).default(''),
  before: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
});
export const requestChange = z.discriminatedUnion('action', [
  z.strictObject({action:z.literal('publish'), title:z.string().trim().min(1).max(120),
    environment:z.string().trim().max(200).default(''), expected_result:z.string().trim().min(1).max(500)}),
  z.strictObject({action:z.enum(['resolve','reopen','withdraw'])}),
]);

function requirePublic(env: Bindings) {
  if (!publicAccessEnabled(env)) throw new HttpError(404,'NOT_FOUND','Public requests are unavailable.');
}

export async function setRoomRequest(env: Bindings, room: string, message: string, actor: Actor, input: unknown) {
  requirePublic(env);
  const parsed = requestChange.safeParse(input);
  if (!parsed.success) throw new HttpError(400,'INVALID_REQUEST','Check the request title, environment and expected result.');
  const change = parsed.data;
  // Check authorship, live membership and public visibility in the write itself.
  const eligible = `SELECT t.id FROM target t JOIN rooms r ON r.id=t.room_id
    WHERE t.own AND r.directory_listed=1 AND ${readablePublicRoom}`;
  const args = [...actorValues(actor),room,message];
  let statement: D1PreparedStatement;
  let warnings: string[] = [];
  if (change.action === 'publish') {
    const agent = actor.auth?.agent;
    if (agent && isQuiet(Date.now(),agent.timezone,agent.quiet_start,agent.quiet_end))
      throw new HttpError(429,'QUIET_HOURS','Quiet hours.');
    if (agent) warnings=sensitiveWarnings([change.title,change.environment,change.expected_result].join(' '),JSON.parse(agent.private_categories));
    statement = env.DB.prepare(target + ` INSERT INTO room_requests(message_id,title,environment,expected_result)
      SELECT id,?,?,? FROM (${eligible}) WHERE true ON CONFLICT(message_id) DO UPDATE SET
      title=excluded.title,environment=excluded.environment,expected_result=excluded.expected_result`)
      .bind(...args,change.title,change.environment,change.expected_result);
  } else if (change.action === 'withdraw') {
    statement = env.DB.prepare(target + ` DELETE FROM room_requests WHERE message_id IN (${eligible})`).bind(...args);
  } else {
    statement = env.DB.prepare(target + ` UPDATE room_requests SET status=? WHERE message_id IN (${eligible})`)
      .bind(...args,change.action === 'resolve' ? 'resolved' : 'open');
  }
  const writes=[statement];
  if (warnings.length) writes.push(env.DB.prepare(`INSERT INTO notifications(id,user_id,kind,body,room_id,created_at,source_message_id)
    SELECT ?,?,'privacy_warning',?,?,?,? WHERE changes()>0`).bind(crypto.randomUUID(),actor.user,
      'エージェントの公開依頼に非公開情報が含まれる可能性があります。',room,Date.now(),message));
  const [write]=await env.DB.batch(writes);
  if (!write.meta.changes)
    throw new HttpError(409,'REQUEST_UNAVAILABLE','Only the participating author can manage a request in a listed public room.');
  return {saved:true,warnings};
}

export async function readRoomRequests(env: Bindings, viewer: string, input: unknown, guestHashes: string[] = [], message?: string) {
  requirePublic(env);
  const parsed = requestQuery.safeParse(input);
  if (!parsed.success) throw new HttpError(400,'INVALID_QUERY','Check the query and cursor.');
  const {before, query} = parsed.data;
  const limit = 20;
  const filter = message !== undefined ? 'q.message_id=?' : `q.status='open' AND q.publication_id<?
    AND (?='' OR instr(lower(q.title || ' ' || q.environment || ' ' || q.expected_result || ' ' || m.body), lower(?))>0)`;
  const rows = await env.DB.prepare(`${listedViewers}
    SELECT q.*,m.seq AS message_seq, m.body, r.id AS room_id,r.name AS room_name,r.access_mode='anonymous' AS guest_joinable
    FROM room_requests q JOIN messages m ON m.id=q.message_id JOIN rooms r ON r.id=m.room_id
    JOIN viewers v ON v.room_id=r.id WHERE m.deleted_at IS NULL AND ${admitted} AND ${filter}
    ORDER BY q.publication_id DESC LIMIT ?`).bind(JSON.stringify(guestHashes),viewer,
      ...(message !== undefined ? [message] : [before ?? Number.MAX_SAFE_INTEGER,query,query]),limit+1)
    .all<Omit<RoomRequest,'guest_joinable'|'url'> & {guest_joinable:number}>();
  if (message !== undefined && !rows.results.length) throw new HttpError(404,'REQUEST_NOT_FOUND','Request unavailable.');
  const requests = rows.results.slice(0,limit).map(r=>({...r,guest_joinable:Boolean(r.guest_joinable),
    url:(env.DIRECTORY_ORIGIN || env.PUBLIC_ORIGIN)+requestPath(r.message_id)}));
  return {requests,next_before:rows.results.length>limit ? requests[limit-1].publication_id : null};
}
