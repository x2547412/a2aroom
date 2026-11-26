import { broadcastChange, subscribeChanges } from './directory-hub';
import { HttpError, type Bindings, type Session } from './types';

function channel(hash: string) {
  return 'inbox-session:' + hash;
}

export function subscribeInbox(env: Bindings, request: Request, session: Session) {
  return subscribeChanges(env, request, channel(session.tokenHash));
}

// Both the wake and the preview require current membership and mutual visibility.
const incoming = `rm.kind='human' AND m.deleted_at IS NULL AND m.created_at >= rm.joined_at
  AND (m.author_agent_id IS NOT NULL OR m.author_user_id <> rm.user_id)
  AND NOT EXISTS (SELECT 1 FROM blocks b WHERE
    (b.user_id=rm.user_id AND b.blocked_user_id=m.author_user_id)
    OR (b.blocked_user_id=rm.user_id AND b.user_id=m.author_user_id))`;

export async function latestIncoming(env: Bindings, user: string, after: string | undefined, guestRoom?: string) {
  const seq = after === undefined ? 0 : Number(after);
  if (!Number.isSafeInteger(seq) || seq < 0) throw new HttpError(400, 'INVALID_CURSOR', '新着位置が正しくありません。');
  // The room/seq index lets each joined room contribute just its latest visible message.
  const message = await env.DB.prepare(`SELECT m.id, m.seq, m.room_id, r.name AS room_name,
    CASE WHEN u.is_guest=1 THEN COALESCE(u.display_name,'匿名') ELSE COALESCE(m.agent_name_snapshot,a.name,u.display_name,u.account_name) END AS sender,
    m.author_agent_id, m.author_user_id, substr(m.body,1,120) AS preview
    FROM room_members rm JOIN rooms r ON r.id=rm.room_id
    JOIN messages m ON m.seq=(SELECT m.seq FROM messages m WHERE m.room_id=rm.room_id AND m.seq>?2
      AND ${incoming} ORDER BY m.seq DESC LIMIT 1)
    JOIN users u ON u.id=m.author_user_id LEFT JOIN agents a ON a.id=m.author_agent_id
    WHERE rm.user_id=?1 AND rm.kind='human'
      AND (?3 IS NULL OR (r.id=?3 AND r.visibility='public' AND r.access_mode='anonymous'))
    ORDER BY m.seq DESC LIMIT 1`).bind(user, seq, guestRoom ?? null).first();
  return { message };
}

export async function notifyInboxes(env: Bindings, messageId: string) {
  const targets = await env.DB.prepare(`WITH recipients AS (
    SELECT rm.user_id, rm.room_id, r.access_mode, r.visibility, u.is_guest FROM messages m
    JOIN room_members rm ON rm.room_id=m.room_id JOIN users u ON u.id=rm.user_id
    JOIN rooms r ON r.id=rm.room_id WHERE m.id=?1 AND ${incoming}
    AND (?2 <> 'true' OR u.id=(SELECT user_id FROM account_names WHERE name=?3 AND original=1))
  ) SELECT s.token_hash FROM recipients t JOIN sessions s ON s.user_id=t.user_id
    WHERE t.is_guest=0 AND s.expires_at>?4
    UNION ALL SELECT g.token_hash FROM recipients t JOIN guest_sessions g ON g.user_id=t.user_id AND g.room_id=t.room_id
    WHERE t.is_guest=1 AND t.access_mode='anonymous' AND t.visibility='public' AND g.expires_at>?4`)
    .bind(messageId, env.PRIVATE_BETA, env.OWNER_ACCOUNT, Date.now()).all<{ token_hash: string }>();
  for (let i = 0; i < targets.results.length; i += 8) {
    await Promise.all(targets.results.slice(i, i + 8).map(row => broadcastChange(env, channel(row.token_hash))));
  }
}
