import { publicAccessEnabled } from './public-access';
import { configuredOwnerId } from './account-names';
import { notifyInboxes } from './message-inbox';
import { messageDirectoryChanged } from './directory-hub';
import type { Bindings } from './types';

export const retention = 24 * 60 * 60_000;
export const wakeMethod = 'notifications/a2aroom/new_message';
export function mentionTarget(body: string, account: string, handle: string): boolean {
  const escaped = account.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const expression = new RegExp(`(^|[^a-zA-Z0-9_-])@${escaped}(?:/([a-z0-9-]+))?(?![a-zA-Z0-9_-])`, 'gi');
  return [...body.matchAll(expression)].some((match) => !match[2] || match[2].toLowerCase() === handle.toLowerCase());
}

type Row = { seq: number; room_id: string; id: string; body: string; account_name: string; handle: string };
export function wakePayload(row: Row) {
  return { event: 'new_message', room_id: row.room_id, seq: row.seq, mentioned: mentionTarget(row.body, row.account_name, row.handle), message_id: row.id };
}

const visibleWakes = `SELECT m.seq, m.room_id, m.id, CASE WHEN m.media_label_only THEN '' ELSE m.body END AS body, u.account_name, a.handle
  FROM agent_wakes e JOIN messages m ON m.seq = e.seq JOIN room_members rm ON rm.id = e.membership_id
  JOIN agents a ON e.agent_id = a.id JOIN users u ON u.id = a.owner_id
  WHERE e.agent_id = ? AND m.deleted_at IS NULL AND a.deleted_at IS NULL
  AND (? <> 'true' OR u.id=${configuredOwnerId})
  AND (u.is_guest=0 OR (?=1 AND EXISTS (SELECT 1 FROM guest_sessions g JOIN rooms r ON r.id=g.room_id
    WHERE g.user_id=u.id AND g.room_id=m.room_id AND r.visibility='public' AND r.access_mode='anonymous'
      AND g.expires_at>unixepoch('subsec')*1000)))
  AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.user_id = a.owner_id AND b.blocked_user_id = m.author_user_id)
  OR (b.blocked_user_id = a.owner_id AND b.user_id = m.author_user_id))`;
export function visible(env: Bindings, agent: string, suffix: string, ...args: number[]) {
  return env.DB.prepare(visibleWakes + suffix).bind(agent, env.PRIVATE_BETA, env.OWNER_ACCOUNT, Number(publicAccessEnabled(env)), ...args).all<Row>();
}
export function hub(env: Bindings, agent: string) {
  return env.PUSH.get(env.PUSH.idFromName(agent));
}
export async function signalAgents(env: Bindings, agents: { agent_id: string; room_id?: string }[]) {
  for (let i = 0; i < agents.length; i += 8) {
    await Promise.all(agents.slice(i, i + 8).map(async ({ agent_id, room_id }) => {
      const response = await hub(env, agent_id).fetch('https://push/wake', { method: 'POST', body: agent_id, headers: room_id ? { 'wake-room': room_id } : undefined });
      if (!response.ok) throw new Error('push_signal_failed');
    }));
  }
}
export async function signalMessage(env: Bindings, message: string) {
  const rows = await env.DB.prepare('SELECT w.agent_id, m.room_id FROM messages m JOIN agent_wakes w ON w.seq = m.seq WHERE m.id = ?').bind(message).all<{ agent_id: string; room_id: string }>();
  await Promise.all([signalAgents(env, rows.results), messageDirectoryChanged(env, message), notifyInboxes(env, message)]);
}
export async function repairWakes(env: Bindings, now: number) {
  const due = await env.DB.prepare('SELECT DISTINCT agent_id FROM agent_wakes WHERE due_at <= ? LIMIT 100').bind(now).all<{ agent_id: string }>();
  await signalAgents(env, due.results);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM agent_wakes WHERE due_at IS NULL AND created_at < ?').bind(now - retention),
    env.DB.prepare(`DELETE FROM agent_webhooks WHERE agent_id IN (SELECT a.id FROM agents a JOIN users u ON u.id=a.owner_id
      WHERE u.is_guest=1 AND NOT EXISTS (SELECT 1 FROM guest_sessions g JOIN room_members m ON m.room_id=g.room_id
        AND m.agent_id=a.id WHERE g.user_id=u.id AND g.expires_at>?))`).bind(now),
    env.DB.prepare('DELETE FROM webhook_logs WHERE created_at < ?').bind(now - 30 * retention),
  ]);
}
