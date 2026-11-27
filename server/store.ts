import { verificationFlags } from './verification';
import { guestAccess, guestRoomScope, roomAudience } from './public-access';
import { configuredOwnerId } from './account-names';
import { messageExtras, storeUpload, type RichMessage } from './chat-media';
import type { Agent, AgentAuth, Bindings, User } from './types';
import { HttpError } from './types';
import { dayStart, isQuiet, sensitiveWarnings, validateText } from './domain';

export type Room = { id: string; host_user_id: string; host_account: string; directory_listed: number; name: string; description: string; visibility: 'public' | 'invite'; access_mode: 'invite' | 'registered' | 'anonymous'; created_at: number };
export type Message = {
  seq: number; id: string; room_id: string; author_user_id: string; author_agent_id: string | null;
  account_name: string; agent_name: string | null; platform: string | null;
  media_label_only: number; body: string; reply_to: string | null; created_at: number; edited_at: number | null;
};

const visibleClause = `NOT EXISTS (SELECT 1 FROM blocks b WHERE
  (b.user_id = ? AND b.blocked_user_id = m.author_user_id) OR
  (b.blocked_user_id = ? AND b.user_id = m.author_user_id))`;

export async function ownedAgent(env: Bindings, ownerId: string, agentId: string): Promise<Agent> {
  const agent = await env.DB.prepare('SELECT * FROM agents WHERE id = ? AND owner_id = ? AND deleted_at IS NULL')
    .bind(agentId, ownerId).first<Agent>();
  if (!agent) throw new HttpError(404, 'AGENT_NOT_FOUND', 'エージェントが見つかりません。');
  return agent;
}

export async function getRoom(env: Bindings, roomId: string): Promise<Room> {
  const room = await env.DB.prepare(`SELECT r.*, CASE WHEN u.is_guest=1 THEN '匿名' ELSE u.account_name END AS host_account FROM rooms r JOIN users u ON u.id = r.host_user_id WHERE r.id = ?`)
    .bind(roomId).first<Room>();
  if (!room) throw new HttpError(404, 'ROOM_NOT_FOUND', 'ルームが見つかりません。');
  return room;
}

export async function requireHumanMember(env: Bindings, user: User, roomId: string): Promise<Room> {
  const room = await getRoom(env, roomId);
  const membership = await env.DB.prepare("SELECT id FROM room_members WHERE room_id = ? AND user_id = ? AND kind = 'human'")
    .bind(roomId, user.id).first();
  if (!membership) throw new HttpError(403, 'NOT_A_MEMBER', 'このルームに参加していません。');
  return room;
}

export async function requireAgentMember(env: Bindings, auth: AgentAuth, roomId: string): Promise<Room> {
  const room = await getRoom(env, roomId);
  const member = await env.DB.prepare("SELECT id FROM room_members WHERE room_id = ? AND agent_id = ? AND kind = 'agent'")
    .bind(roomId, auth.agent.id).first();
  if (!member) throw new HttpError(403, 'NOT_A_MEMBER', 'このエージェントはルームに参加していません。');
  return room;
}


export async function listMessages(env: Bindings, viewerId: string, roomId: string, afterSeq: number, limit: number, agentId: string, guestHash?: string, pollingConnection?: string): Promise<Message[]> {
  const result = await env.DB.prepare(`SELECT m.seq, m.id, m.room_id, m.author_user_id, m.author_agent_id,
      (SELECT h.handle FROM guest_agent_handles h WHERE h.agent_id=m.author_agent_id) AS guest_handle,
      ${verificationFlags}, u.is_guest, CASE WHEN u.is_guest = 1 THEN 'Anonymous' ELSE u.account_name END AS account_name, u.display_name, COALESCE(m.agent_name_snapshot, a.name) AS agent_name, COALESCE(m.agent_platform_snapshot, a.platform) AS platform, m.sticker_id, m.media_label_only, m.body,
      CASE WHEN EXISTS (SELECT 1 FROM messages parent WHERE parent.id = m.reply_to AND parent.room_id = m.room_id AND parent.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM blocks pb WHERE (pb.user_id = ? AND pb.blocked_user_id = parent.author_user_id) OR (pb.blocked_user_id = ? AND pb.user_id = parent.author_user_id)))
        THEN m.reply_to ELSE NULL END AS reply_to, m.created_at, m.edited_at
    FROM messages m JOIN users u ON u.id = m.author_user_id LEFT JOIN agents a ON a.id = m.author_agent_id
    WHERE m.room_id = ? AND m.seq > ? AND m.deleted_at IS NULL AND ${visibleClause}
    ${pollingConnection ? `AND m.author_agent_id IS NOT ? AND EXISTS (
        SELECT 1 FROM room_members rm JOIN agent_connections c ON c.agent_id=rm.agent_id
        JOIN agents current ON current.id=rm.agent_id WHERE rm.room_id=m.room_id AND rm.kind='agent'
        AND c.id=? AND rm.agent_id=? AND c.revoked_at IS NULL AND current.deleted_at IS NULL)` : ''} ${guestHash ? `AND ${guestAccess}` : ''} ORDER BY m.seq ASC LIMIT ?`)
    .bind(viewerId, viewerId, roomId, afterSeq, viewerId, viewerId, ...(pollingConnection ? [agentId, pollingConnection, agentId] : []), ...(guestHash ? [guestHash,roomId,agentId] : []), Math.max(1, Math.min(100, limit))).all<Message>();
  const extras = await messageExtras(env, viewerId, result.results.map(m => m.id), agentId);
  return result.results.map(m => ({ ...m, attachments: extras.files.get(m.id) ?? [], reactions: extras.counts.get(m.id) ?? [] }));
}

export async function cursorSeq(env: Bindings, roomId: string, kind: 'human' | 'agent', subjectId: string): Promise<number> {
  const row = await env.DB.prepare('SELECT last_seq FROM read_cursors WHERE room_id = ? AND kind = ? AND subject_id = ?')
    .bind(roomId, kind, subjectId).first<{ last_seq: number }>();
  return row?.last_seq ?? 0;
}

export async function advanceCursor(env: Bindings, roomId: string, kind: 'human' | 'agent', subjectId: string, seq: number): Promise<void> {
  await env.DB.prepare(`INSERT INTO read_cursors (room_id, kind, subject_id, last_seq) VALUES (?, ?, ?, ?)
    ON CONFLICT(room_id, kind, subject_id) DO UPDATE SET last_seq = MAX(read_cursors.last_seq, excluded.last_seq)`)
    .bind(roomId, kind, subjectId, seq).run();
}

// A cursor alone cannot prove which messages were returned by a partial history request.
export async function recordAgentReads(env: Bindings, auth: AgentAuth, roomId: string, messages: Message[], advanceTo?: number): Promise<void> {
  const received = messages.filter((message) => message.author_agent_id !== auth.agent.id);
  const statements: D1PreparedStatement[] = [];
  // Keep each statement under D1's bound-parameter limit, including the fixed parameters.
  for (let offset = 0; offset < received.length; offset += 40) {
    const chunk = received.slice(offset, offset + 40);
    statements.push(env.DB.prepare(`INSERT OR IGNORE INTO agent_message_reads (message_id, agent_id, read_at)
      SELECT m.id, ?, ? FROM messages m WHERE m.room_id = ? AND (${chunk.map(() => '(m.id = ? AND m.edited_at IS ?)').join(' OR ')})
      AND m.deleted_at IS NULL AND COALESCE(m.author_agent_id, '') <> ?
      AND EXISTS (SELECT 1 FROM room_members rm WHERE rm.room_id = m.room_id AND rm.kind = 'agent' AND rm.agent_id = ?)
      AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.user_id = ? AND b.blocked_user_id = m.author_user_id)
        OR (b.blocked_user_id = ? AND b.user_id = m.author_user_id))`)
      .bind(auth.agent.id, Date.now(), roomId, ...chunk.flatMap((message) => [message.id, message.edited_at]), auth.agent.id, auth.agent.id, auth.agent.owner_id, auth.agent.owner_id));
  }
  if (advanceTo !== undefined) {
    statements.push(env.DB.prepare(`INSERT INTO read_cursors (room_id, kind, subject_id, last_seq) VALUES (?, 'agent', ?, ?)
      ON CONFLICT(room_id, kind, subject_id) DO UPDATE SET last_seq = MAX(read_cursors.last_seq, excluded.last_seq)`)
      .bind(roomId, auth.agent.id, advanceTo));
  }
  if (statements.length) await env.DB.batch(statements);
}

export async function resolveSince(env: Bindings, roomId: string, since: string | undefined): Promise<number> {
  if (!since) return 0;
  const message = await env.DB.prepare('SELECT seq FROM messages WHERE id = ? AND room_id = ?').bind(since, roomId).first<{ seq: number }>();
  if (message) return message.seq;
  const date = Date.parse(since);
  if (Number.isFinite(date)) {
    const previous = await env.DB.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM messages WHERE room_id = ? AND created_at <= ?')
      .bind(roomId, date).first<{ seq: number }>();
    return previous?.seq ?? 0;
  }
  throw new HttpError(400, 'INVALID_CURSOR', 'メッセージの取得位置が不正です。');
}

export async function checkReply(env: Bindings, viewerId: string, roomId: string, replyTo: string | null): Promise<void> {
  if (!replyTo) return;
  const message = await env.DB.prepare(`SELECT m.id FROM messages m WHERE m.id = ? AND m.room_id = ? AND m.deleted_at IS NULL AND ${visibleClause}`)
    .bind(replyTo, roomId, viewerId, viewerId).first();
  if (!message) throw new HttpError(400, 'INVALID_REPLY', '返信先のメッセージを表示できません。');
}

function replyNotification(env: Bindings, id: string) {
  return env.DB.prepare(`INSERT INTO notifications (id, user_id, kind, body, room_id, created_at, source_user_id, source_message_id)
    SELECT ?, parent.author_user_id, 'reply', '発言に返信が届きました。', m.room_id, m.created_at, m.author_user_id, m.id
    FROM messages m JOIN messages parent ON parent.id = m.reply_to AND parent.room_id = m.room_id
    JOIN room_members rm ON rm.room_id = m.room_id AND rm.user_id = parent.author_user_id AND rm.kind = 'human'
    JOIN users recipient ON recipient.id = rm.user_id AND recipient.is_guest = 0
    WHERE m.id = ? AND parent.deleted_at IS NULL
    AND (m.author_user_id <> parent.author_user_id OR (m.author_agent_id IS NOT NULL AND m.author_agent_id IS NOT parent.author_agent_id))
    AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.user_id = rm.user_id AND b.blocked_user_id = m.author_user_id)
      OR (b.blocked_user_id = rm.user_id AND b.user_id = m.author_user_id))
    AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.source_message_id = m.id AND n.user_id = rm.user_id AND n.kind = 'mention')`)
    .bind(crypto.randomUUID(), id);
}

function attachmentWrites(env:Bindings,id:string,media?:RichMessage) {
  const statements:D1PreparedStatement[]=[];
  for (const [position,file] of (media?.files ?? []).entries()) {
    statements.push(env.DB.prepare(`INSERT INTO message_attachments(id,message_id,position,name,mime,kind,size)
      SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM messages WHERE id=?)`)
      .bind(file.id,id,position,file.name,file.mime,file.kind,file.size,id),
      env.DB.prepare('DELETE FROM media_cleanup WHERE id=? AND EXISTS (SELECT 1 FROM message_attachments WHERE id=?)').bind(file.id,file.id));
  }
  return statements;
}

export async function postHumanMessage(env: Bindings, user: User, roomId: string, rawBody: unknown, replyTo: string | null, media?: RichMessage): Promise<string> {
  await requireHumanMember(env, user, roomId);
  const body = validateText(media?.labelOnly ? media.fallback : rawBody, 4000, 'メッセージ');
  const previousPost = () => env.DB.prepare(
    'SELECT id FROM messages WHERE room_id = ? AND author_user_id = ? AND media_request_id = ? AND deleted_at IS NULL'
  ).bind(roomId, user.id, media?.requestId ?? null).first<string>('id');
  if (media) {
    const existing = await previousPost();
    if (existing) return existing;
  }
  await checkReply(env, user.id, roomId, replyTo);
  const signature = media ? await storeUpload(env, media, media.labelOnly ? '' : body, replyTo) : null;
  const id = crypto.randomUUID();
  const now = Date.now();
  const mentions = [...(media?.labelOnly ? '' : body).matchAll(/(?:^|[^a-zA-Z0-9_-])@([a-z0-9]+(?:-[a-z0-9]+)*)(?![a-z0-9/-])/gi)].map((match) => match[1].toLowerCase());
  const targets = [...new Set(mentions)].slice(0, 30);
  const statements: D1PreparedStatement[] = [env.DB.prepare(`INSERT INTO messages (id, room_id, author_user_id, body, reply_to, created_at, sticker_id, media_label_only, media_request_id, media_signature)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ? AND kind = 'human')
    AND EXISTS (SELECT 1 FROM users poster JOIN rooms target ON target.id = ?
      WHERE poster.id = ? AND (poster.is_guest = 0 OR target.access_mode = 'anonymous'))
    AND NOT COALESCE((SELECT CASE WHEN ? IS NULL THEN body = ? ELSE media_signature = ? END
      FROM messages WHERE room_id = ? AND author_user_id = ? AND author_agent_id IS NULL ORDER BY seq DESC LIMIT 1), 0)
    ON CONFLICT(author_user_id,room_id,media_request_id) WHERE media_request_id IS NOT NULL DO NOTHING`)
    .bind(id, roomId, user.id, body, replyTo, now, media?.sticker ?? null, Number(media?.labelOnly ?? false), media?.requestId ?? null, signature,
      roomId, user.id, roomId, user.id, signature, body, signature, roomId, user.id)];
  statements.push(...attachmentWrites(env,id,media));
  for (const account of targets) {
    statements.push(env.DB.prepare(`INSERT INTO notifications (id, user_id, kind, body, room_id, created_at, source_user_id, source_message_id)
      SELECT ?, u.id, 'mention', ?, ?, ?, ?, ? FROM users u JOIN room_members rm ON rm.user_id = u.id AND rm.kind = 'human' AND rm.room_id = ?
      LEFT JOIN notification_settings ns ON ns.user_id = u.id
      WHERE NOT EXISTS (SELECT 1 FROM notifications n WHERE n.user_id=u.id AND n.source_message_id=? AND n.kind='mention') AND u.account_name=? COLLATE NOCASE AND u.id <> ? AND COALESCE(ns.mention_enabled, 1) = 1 AND EXISTS (SELECT 1 FROM messages WHERE id = ?)
      AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.user_id = u.id AND b.blocked_user_id = ?) OR (b.blocked_user_id = u.id AND b.user_id = ?))`)
      .bind(crypto.randomUUID(), `${user.account_name}さんからメンションが届きました。`, roomId, now, user.id, id, roomId, id, account, user.id, id, user.id, user.id));
  }
  if (replyTo) statements.push(replyNotification(env, id));
  const results = await env.DB.batch(statements);
  if (!results[0].meta.changes && media) {
    const previous = await previousPost();
    if (previous) return previous;
  }
  if (!results[0].meta.changes) throw new HttpError(409, 'DUPLICATE_MESSAGE', '同じ内容の連続投稿はできません。');
  return id;
}

export async function checkAgentConnection(env: Bindings, agentId: string, connectionId: string, userId?: string): Promise<AgentAuth> {
  const agent = await env.DB.prepare(`SELECT a.* FROM agents a JOIN agent_connections c ON c.agent_id = a.id JOIN users u ON u.id = a.owner_id
    WHERE a.id = ? AND c.id = ? AND c.revoked_at IS NULL AND a.deleted_at IS NULL AND (? <> 'true' OR u.id=${configuredOwnerId})`)
    .bind(agentId, connectionId, env.PRIVATE_BETA, env.OWNER_ACCOUNT).first<Agent>();
  if (!agent || (userId && agent.owner_id !== userId)) throw new HttpError(401, 'TOKEN_REVOKED', '接続が失効しています。');
  return { agent, connectionId };
}

export async function postAgentMessage(env: Bindings, auth: AgentAuth, roomId: string, rawBody: unknown, replyTo: string | null, guestHash?: string, media?:RichMessage): Promise<{ id: string; warnings: string[] }> {
  const agent = await ownedAgent(env, auth.agent.owner_id, auth.agent.id);
  await requireAgentMember(env, { ...auth, agent }, roomId);
  const body = validateText(media?.labelOnly ? media.fallback : rawBody, 4000, 'メッセージ');
  const previous = () => env.DB.prepare('SELECT id FROM messages WHERE room_id=? AND author_agent_id=? AND media_request_id=? AND deleted_at IS NULL').bind(roomId,agent.id,media?.requestId ?? null).first<string>('id');
  if (media) {
    const existing = await previous();
    if (existing) return {id:existing,warnings:[]};
  }
  await checkReply(env, agent.owner_id, roomId, replyTo);
  const now = Date.now();
  if (isQuiet(now, agent.timezone, agent.quiet_start, agent.quiet_end)) {
    throw new HttpError(429, 'QUIET_HOURS', '静かな時間帯のため投稿できません。');
  }
  const limitStart = dayStart(now, agent.timezone);
  const id = crypto.randomUUID();
  const signature = media ? await storeUpload(env,media,media.labelOnly ? '' : body,replyTo) : null;
  const categories = JSON.parse(agent.private_categories) as string[];
  const warnings = sensitiveWarnings(body, categories);
  const statements: D1PreparedStatement[] = [env.DB.prepare(`INSERT INTO messages
    (id, room_id, author_user_id, author_agent_id, body, reply_to, created_at, agent_name_snapshot, agent_platform_snapshot,sticker_id,media_label_only,media_request_id,media_signature)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?,?,?,?,?
    WHERE EXISTS (SELECT 1 FROM agents a JOIN agent_connections c ON c.agent_id = a.id
      WHERE a.id = ? AND a.owner_id = ? AND a.deleted_at IS NULL AND a.policy_revision = ? AND c.id = ? AND c.revoked_at IS NULL)
    AND EXISTS (SELECT 1 FROM room_members WHERE room_id = ? AND agent_id = ? AND kind = 'agent')
    ${guestHash ? `AND ${guestAccess}` : ''}
    AND (SELECT COUNT(*) FROM messages WHERE author_agent_id = ? AND created_at >= ?) < ?
    AND (SELECT COUNT(*) FROM messages WHERE author_agent_id = ? AND room_id = ? AND created_at >= ?) < 60
    AND NOT COALESCE((SELECT CASE WHEN ? IS NULL THEN body=? ELSE media_signature=? END FROM messages
      WHERE room_id=? AND author_agent_id=? ORDER BY seq DESC LIMIT 1),0)
    ON CONFLICT(author_user_id,room_id,media_request_id) WHERE media_request_id IS NOT NULL DO NOTHING`)
    .bind(id, roomId, agent.owner_id, agent.id, body, replyTo, now, agent.name, agent.platform,media?.sticker??null,Number(media?.labelOnly??false),media?.requestId??null,signature,
      agent.id, agent.owner_id, agent.policy_revision, auth.connectionId,
      roomId, agent.id, ...(guestHash ? [guestHash,roomId,agent.id] : []), agent.id, limitStart, Math.min(agent.daily_limit, 200),
      agent.id, roomId, now - 60 * 60_000, signature,body,signature,roomId,agent.id)];
  statements.push(...attachmentWrites(env,id,media));
  if (warnings.length) {
    statements.push(env.DB.prepare(`INSERT INTO notifications (id, user_id, kind, body, room_id, created_at, source_message_id)
      SELECT ?, ?, 'privacy_warning', ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM messages WHERE id = ?)`)
      .bind(crypto.randomUUID(), agent.owner_id, `${agent.name}の投稿に非公開情報が含まれる可能性があります。内容をご確認ください。`, roomId, now, id, id));
  }
  if (replyTo) statements.push(replyNotification(env, id));
  const results = await env.DB.batch(statements);
  if (!results[0].meta.changes && media) {
    const existing=await previous();
    if (existing) return {id:existing,warnings:[]};
  }
  if (!results[0].meta.changes) throw new HttpError(429, 'POST_LIMIT', '発言上限、同一内容、または接続・設定の変更により投稿できません。');
  return { id, warnings };
}

const activeRoomConnection = `EXISTS (SELECT 1 FROM room_members rm
  JOIN agent_connections c ON c.agent_id=rm.agent_id AND c.revoked_at IS NULL
  JOIN agents a ON a.id=rm.agent_id AND a.deleted_at IS NULL
  WHERE rm.kind='agent' AND rm.room_id=? AND rm.agent_id=? AND c.id=? AND a.owner_id=?)`;

// Revalidate after assembling a response across multiple D1/R2 reads, without charging another read.
export async function confirmAgentRoomRead(env: Bindings, auth: AgentAuth, room: string) {
  const guest = guestRoomScope(auth.guestHash, room, auth.agent.id);
  const keyScope = auth.guestKeyHash
    ? ` AND EXISTS (SELECT 1 FROM guest_agent_handles h JOIN rooms r ON r.id=?
        WHERE h.agent_id=? AND h.key_hash=? AND ${roomAudience('h.agent_id')})` : '';
  const allowed = await env.DB.prepare(`SELECT 1 WHERE ${activeRoomConnection}${guest.sql}${keyScope}`)
    .bind(room, auth.agent.id, auth.connectionId, auth.agent.owner_id, ...guest.args,
      ...(auth.guestKeyHash ? [room, auth.agent.id, auth.guestKeyHash] : [])).first();
  if (auth.expiresAt !== undefined && Date.now() >= auth.expiresAt * 1000)
    throw new HttpError(401, 'TOKEN_EXPIRED', 'Refresh your access token.');
  if (!allowed) throw new HttpError(403, 'ROOM_UNAVAILABLE', 'Room access is no longer available.');
}

export async function searchMessages(env: Bindings, auth: AgentAuth, room: string, query: string, before: number | undefined, limit: number) {
  await requireAgentMember(env, auth, room);
  const guest=guestRoomScope(auth.guestHash,room,auth.agent.id);
  const hit = 'instr(lower(m.body), lower(?))';
  const rows = await env.DB.prepare(`SELECT m.id, m.seq, m.created_at, m.author_user_id, m.author_agent_id,
    substr(m.body, max(1, ${hit} - 40), 210) AS excerpt FROM messages m
    WHERE m.room_id=? AND m.deleted_at IS NULL AND m.seq < ? AND ${hit} > 0 AND ${visibleClause}
    AND ${activeRoomConnection}${guest.sql} ORDER BY m.seq DESC LIMIT ?`)
    .bind(query, room, before ?? Number.MAX_SAFE_INTEGER, query, auth.agent.owner_id, auth.agent.owner_id,
      room, auth.agent.id, auth.connectionId, auth.agent.owner_id,...guest.args, limit + 1).all<{seq:number}>();
  const messages = rows.results.slice(0, limit);
  return { messages, next_before_seq: rows.results.length > limit ? messages[messages.length - 1].seq : null };
}

export async function changeAgentMessage(env: Bindings, auth: AgentAuth, room: string, id: string, newBody?: string) {
  const agent = auth.agent;
  const guest=guestRoomScope(auth.guestHash,room,agent.id);
  const where = `id=? AND room_id=? AND author_agent_id=? AND author_user_id=? AND deleted_at IS NULL
    AND ${activeRoomConnection}${guest.sql} AND EXISTS (SELECT 1 FROM agents WHERE id=? AND policy_revision=?)`;
  const args = [id, room, agent.id, agent.owner_id, room, agent.id, auth.connectionId, agent.owner_id,...guest.args, agent.id, agent.policy_revision];
  const now = Date.now();
  if (newBody === undefined) {
    const result = await env.DB.prepare(`UPDATE messages SET deleted_at=? WHERE ${where}`).bind(now, ...args).run();
    if (!result.meta.changes) throw new HttpError(404, 'MESSAGE_UNAVAILABLE', 'Message unavailable.');
    return { id };
  }
  if (isQuiet(now, agent.timezone, agent.quiet_start, agent.quiet_end)) throw new HttpError(429, 'QUIET_HOURS', 'Quiet hours.');
  const body = validateText(newBody, 4000, 'Message');
  const warnings = sensitiveWarnings(body, JSON.parse(agent.private_categories));
  const writes = [env.DB.prepare(`UPDATE messages SET body=?, media_label_only=0, edited_at=MAX(COALESCE(edited_at,0)+1,?) WHERE ${where}`).bind(body, now, ...args)];
  if (warnings.length) writes.push(env.DB.prepare(`INSERT INTO notifications(id,user_id,kind,body,room_id,created_at,source_message_id)
    SELECT ?,?,'privacy_warning',?,?,?,? WHERE changes()>0`)
    .bind(crypto.randomUUID(), agent.owner_id, agent.name+'の編集に非公開情報が含まれる可能性があります。', room, now, id));
  writes.push(env.DB.prepare(`DELETE FROM agent_message_reads WHERE message_id=? AND EXISTS (SELECT 1 FROM messages WHERE ${where})`).bind(id,...args));
  const [result] = await env.DB.batch(writes);
  if (!result.meta.changes) throw new HttpError(404, 'MESSAGE_UNAVAILABLE', 'Message unavailable.');
  return { id, warnings };
}

export async function enforceAgentReadRate(env: Bindings, agentId: string): Promise<void> {
  const now = Date.now();
  const result = await env.DB.prepare(`INSERT INTO agent_requests (agent_id, created_at)
    SELECT ?, ? WHERE (SELECT COUNT(*) FROM agent_requests WHERE agent_id = ? AND created_at > ?) < 600`)
    .bind(agentId, now, agentId, now - 60 * 60_000).run();
  if (!result.meta.changes) throw new HttpError(429, 'READ_RATE_LIMIT', '取得上限に達しました。');
}
