import { guestRoomScope } from './public-access';
import { HttpError, type AgentAuth, type Bindings } from './types';

export async function setReplyStatus(env: Bindings, auth: AgentAuth, room: string, active: boolean) {
  const guest=guestRoomScope(auth.guestHash,room,auth.agent.id);
  const until = active ? Date.now() + 30_000 : null;
  const result = await env.DB.prepare(`UPDATE room_members SET reply_until = ?, reply_connection = ?
    WHERE room_id = ? AND agent_id = ? AND kind = 'agent' AND EXISTS
    (SELECT 1 FROM agent_connections WHERE id = ? AND agent_id = room_members.agent_id AND revoked_at IS NULL)${guest.sql}`)
    .bind(until, active ? auth.connectionId : null, room, auth.agent.id, auth.connectionId,...guest.args).run();
  if (!result.meta.changes) throw new HttpError(403, 'NOT_A_MEMBER', 'この接続から返信状態を変更できません。');
  return { expires_at: until };
}

export async function setHumanReplyStatus(env: Bindings, room: string, user: string, active: unknown) {
  if (typeof active !== 'boolean') throw new HttpError(400,'INVALID_STATUS','入力状態を確認してください。');
  const now = Date.now();
  const result = await env.DB.prepare(`UPDATE room_members SET reply_until=?
    WHERE room_id=? AND user_id=? AND kind='human' AND EXISTS (
      SELECT 1 FROM users u JOIN rooms r ON r.id=room_members.room_id WHERE u.id=room_members.user_id
      AND (u.is_guest=0 OR (r.visibility='public' AND r.access_mode='anonymous' AND EXISTS
        (SELECT 1 FROM guest_sessions gs WHERE gs.room_id=r.id AND gs.user_id=u.id AND gs.expires_at>?))))`)
    .bind(active ? now+30_000 : null,room,user,now).run();
  if (!result.meta.changes) throw new HttpError(403,'NOT_A_MEMBER','参加者のみ利用できます。');
  return {ok:true};
}

export async function replyingParticipants(env: Bindings, room: string, viewer: string) {
  const now = Date.now();
  const rows = await env.DB.prepare(`SELECT a.id, a.name, rm.reply_until - ? AS remaining_ms
    FROM room_members rm JOIN agents a ON a.id = rm.agent_id
    JOIN agent_connections c ON c.id = rm.reply_connection AND c.revoked_at IS NULL
    WHERE rm.room_id = ? AND rm.reply_until > ? AND a.deleted_at IS NULL AND NOT EXISTS
    (SELECT 1 FROM blocks WHERE (user_id = ? AND blocked_user_id = a.owner_id)
      OR (blocked_user_id = ? AND user_id = a.owner_id)) ORDER BY rm.joined_at, a.id`)
    .bind(now, room, now, viewer, viewer).all();
  const humans = viewer ? await env.DB.prepare(`SELECT u.id,COALESCE(u.display_name,CASE WHEN u.is_guest=1 THEN '匿名' ELSE u.account_name END) AS name,
    rm.reply_until-? AS remaining_ms FROM room_members rm JOIN users u ON u.id=rm.user_id
    WHERE rm.room_id=? AND rm.kind='human' AND rm.reply_until>? AND u.id<>?
    AND (u.is_guest=0 OR EXISTS (SELECT 1 FROM guest_sessions gs WHERE gs.user_id=u.id AND gs.room_id=rm.room_id AND gs.expires_at>?))
    AND NOT EXISTS (SELECT 1 FROM blocks WHERE (user_id=? AND blocked_user_id=u.id) OR (blocked_user_id=? AND user_id=u.id))
    ORDER BY rm.joined_at,u.id`).bind(now,room,now,viewer,now,viewer,viewer).all() : null;
  return { agents: rows.results, humans: humans?.results ?? [] };
}
