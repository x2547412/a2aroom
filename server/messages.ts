import { verificationFlags } from './verification';
import { compareTimeline, type AgentMembershipEvent } from '../shared/timeline';
import { messageExtras } from './chat-media';
import type { Bindings } from './types';
import { HttpError } from './types';
import { resolveSince } from './store';

export async function recordHumanReads(env: Bindings, viewer: string, room: string, value: unknown, syncReplyNotices = false) {
  if (!Array.isArray(value) || !value.length || value.length > 40 || !value.every(item =>
    item && typeof item.id === 'string' && item.id.length <= 64 && (item.edited_at === null || Number.isSafeInteger(item.edited_at)))) {
    throw new HttpError(400, 'INVALID_RECEIPTS', '既読の対象を確認してください。');
  }
  const visibleMessages = `SELECT m.id FROM messages m JOIN rooms r ON r.id=m.room_id
    JOIN room_members me ON me.room_id=r.id AND me.kind='human' AND me.user_id=?1
    JOIN users u ON u.id=me.user_id WHERE r.id=?2 AND m.deleted_at IS NULL
    AND (u.is_guest=0 OR (r.access_mode='anonymous' AND EXISTS
      (SELECT 1 FROM guest_sessions gs WHERE gs.room_id=r.id AND gs.user_id=u.id AND gs.expires_at>?3)))
    AND (m.author_agent_id IS NOT NULL OR m.author_user_id<>u.id)
    AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.user_id=u.id AND b.blocked_user_id=m.author_user_id)
      OR (b.blocked_user_id=u.id AND b.user_id=m.author_user_id))
    AND (${value.map(() => '(m.id=? AND m.edited_at IS ?)').join(' OR ')})`;
  const args = [viewer, room, Date.now(), ...value.flatMap(item => [item.id, item.edited_at])];
  const receipt = env.DB.prepare(`INSERT OR IGNORE INTO human_message_reads(message_id,user_id)
    SELECT id, ?1 FROM (${visibleMessages})`).bind(...args);
  if (!syncReplyNotices) {
    await receipt.run();
    return false;
  }
  const markReplies = env.DB.prepare(`UPDATE notifications SET read_at=?3
    WHERE user_id=?1 AND room_id=?2 AND kind='reply' AND read_at IS NULL
    AND EXISTS (SELECT 1 FROM notifications incoming WHERE incoming.user_id=?1 AND incoming.room_id=?2
      AND incoming.kind='reply' AND incoming.read_at IS NULL AND incoming.source_message_id IN (${visibleMessages}))`).bind(...args);
  const [, updated] = await env.DB.batch([receipt, markReplies]);
  return updated.meta.changes > 0;
}

export async function roomMessagePage(env: Bindings, viewerId: string, roomId: string, since?: string, before?: string) {
  if (since && before) throw new HttpError(400, 'INVALID_CURSOR', '取得位置を確認してください。');
  const after = since ? await resolveSince(env, roomId, since) : 0;
  const beforeSeq = before ? await resolveSince(env, roomId, before) : null;
  const result = await messageRows(env, viewerId, roomId, after, beforeSeq, Boolean(since)).all<MessageRow>();
  const page = result.results.slice(0, 50);
  const messages = await withDetails(env, viewerId, roomId, since ? page : page.reverse());
  return { messages, has_more: result.results.length > 50 };
}

type MessageRow = { id: string; seq: number; human_read_count: number };

function messageRows(env: Bindings, viewerId: string, roomId: string, after: number, beforeSeq: number | null, ascending: boolean) {
  return env.DB.prepare(`SELECT m.seq, m.id, m.room_id, m.author_user_id, m.author_agent_id, u.is_guest, CASE WHEN u.is_guest = 1 THEN '匿名' ELSE u.account_name END AS account_name,
    (SELECT h.handle FROM guest_agent_handles h WHERE h.agent_id=m.author_agent_id) AS guest_handle, u.display_name AS display_name,
    ${verificationFlags},
    COALESCE(m.agent_name_snapshot, a.name) AS agent_name,
    CASE WHEN a.deleted_at IS NULL AND EXISTS (SELECT 1 FROM room_members rm WHERE rm.room_id=m.room_id AND rm.kind='agent' AND rm.agent_id=a.id)
      THEN a.name END AS current_agent_name, COALESCE(m.agent_platform_snapshot, a.platform) AS platform, m.sticker_id, m.media_label_only, m.body,
    (SELECT COUNT(*) FROM human_message_reads hr WHERE hr.message_id=m.id AND hr.user_id<>?
      AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.user_id=hr.user_id AND b.blocked_user_id IN (?,m.author_user_id))
        OR (b.blocked_user_id=hr.user_id AND b.user_id IN (?,m.author_user_id)))) AS human_read_count,
    CASE WHEN EXISTS (SELECT 1 FROM messages parent WHERE parent.id = m.reply_to AND parent.room_id = m.room_id AND parent.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM blocks pb WHERE (pb.user_id = ? AND pb.blocked_user_id = parent.author_user_id) OR (pb.blocked_user_id = ? AND pb.user_id = parent.author_user_id)))
      THEN m.reply_to ELSE NULL END AS reply_to, m.created_at, m.edited_at
    FROM messages m JOIN users u ON u.id = m.author_user_id LEFT JOIN agents a ON a.id = m.author_agent_id
    WHERE m.room_id = ? AND m.seq > ? AND (? IS NULL OR m.seq < ?) AND m.deleted_at IS NULL AND NOT EXISTS
      (SELECT 1 FROM blocks b WHERE (b.user_id = ? AND b.blocked_user_id = m.author_user_id) OR (b.blocked_user_id = ? AND b.user_id = m.author_user_id))
    ORDER BY m.seq ${ascending ? 'ASC' : 'DESC'} LIMIT 51`).bind(viewerId, viewerId, viewerId, viewerId, viewerId, roomId, after, beforeSeq, beforeSeq, viewerId, viewerId);
}

async function withDetails(env: Bindings, viewerId: string, roomId: string, page: MessageRow[], agentId:string|null=null) {
  const readers = new Map<string, Array<{ agent_id: string; agent_name: string; account_name: string }>>();
  if (page.length) {
    const receipts = await env.DB.prepare(`SELECT mr.message_id, a.id AS agent_id, a.name AS agent_name, u.account_name
      FROM agent_message_reads mr JOIN messages m ON m.id = mr.message_id
      JOIN agents a ON a.id = mr.agent_id JOIN users u ON u.id = a.owner_id
      WHERE m.room_id = ? AND mr.message_id IN (${page.map(() => '?').join(',')}) AND a.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.user_id = ? AND b.blocked_user_id = a.owner_id)
        OR (b.blocked_user_id = ? AND b.user_id = a.owner_id))
      AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.user_id = a.owner_id AND b.blocked_user_id = m.author_user_id)
        OR (b.blocked_user_id = a.owner_id AND b.user_id = m.author_user_id))
      ORDER BY mr.read_at, a.id`)
      .bind(roomId, ...page.map((message) => message.id), viewerId, viewerId)
      .all<{ message_id: string; agent_id: string; agent_name: string; account_name: string }>();
    for (const receipt of receipts.results) {
      const list = readers.get(receipt.message_id) ?? [];
      list.push({ agent_id: receipt.agent_id, agent_name: receipt.agent_name, account_name: receipt.account_name });
      readers.set(receipt.message_id, list);
    }
  }
  const extras = await messageExtras(env, viewerId, page.map(m => String(m.id)),agentId);
  return page.map((message) => ({ ...message, attachments: extras.files.get(String(message.id)) ?? [], reactions: extras.counts.get(String(message.id)) ?? [], read_count: Number(message.human_read_count) + (readers.get(String(message.id))?.length ?? 0), read_by: readers.get(String(message.id)) ?? [] }));
}

export async function roomTimelinePage(env: Bindings, viewer: string, room: string, cursor?: string, agentId:string|null=null) {
  const [seq, order] = cursor?.split('.').map(Number) ?? [Number.MAX_SAFE_INTEGER, 0];
  if (cursor !== undefined && (!/^\d+\.\d+$/.test(cursor) || !Number.isSafeInteger(seq) || !Number.isSafeInteger(order))) {
    throw new HttpError(400, 'INVALID_CURSOR', '会話の取得位置が正しくありません。');
  }
  // On an event boundary the message at the same sequence is still on the older page.
  const messages = messageRows(env, viewer, room, 0, order ? seq + 1 : seq, false);
  const events = env.DB.prepare(`SELECT 'event:' || event_order AS id, e.room_id, after_message_seq AS seq, event_order,
    u.is_guest, (SELECT h.handle FROM guest_agent_handles h WHERE h.agent_id=e.agent_id) AS guest_handle,
    CASE WHEN u.is_guest THEN '匿名' ELSE u.account_name END AS account_name, e.agent_name, e.agent_handle, e.agent_platform, rm.agent_id AS member_agent_id, action, e.created_at
    FROM agent_membership_events e JOIN users u ON u.id=e.owner_id
    LEFT JOIN room_members rm ON rm.room_id=e.room_id AND rm.kind='agent' AND rm.agent_id=e.agent_id
    WHERE e.room_id=?1 AND (after_message_seq, event_order) < (?2, ?3) AND NOT EXISTS
      (SELECT 1 FROM blocks b WHERE (b.user_id=?4 AND b.blocked_user_id=e.owner_id)
        OR (b.blocked_user_id=?4 AND b.user_id=e.owner_id))
    ORDER BY after_message_seq DESC, event_order DESC LIMIT 51`).bind(room, seq, order, viewer);
  const revision = await env.DB.prepare('SELECT moderation_revision FROM rooms WHERE id=?').bind(room).first<number>('moderation_revision');
  if (revision === null) throw new HttpError(404,'ROOM_NOT_FOUND','ルームが見つかりません。');
  const [messagePage, eventPage] = await env.DB.batch<MessageRow | AgentMembershipEvent>([messages, events]);
  const combined = [...messagePage.results, ...eventPage.results].sort(compareTimeline);
  const items = combined.slice(-50);
  const hydrated = await withDetails(env, viewer, room, items.filter(item => 'human_read_count' in item),agentId);
  return { moderation_revision: revision, items: [...hydrated, ...items.filter(item => 'event_order' in item)].sort(compareTimeline), has_more: combined.length > items.length };
}
