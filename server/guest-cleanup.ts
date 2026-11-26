import type { Bindings } from './types';

// Preserve users and messages: guest identities may still own rooms or have history.
const liveHumanGuest = `SELECT 1 FROM guest_sessions s
  JOIN room_members m ON m.room_id=s.room_id AND m.user_id=s.user_id AND m.kind='human'
  JOIN rooms r ON r.id=s.room_id AND r.visibility='public' AND r.access_mode='anonymous'
  WHERE s.user_id=profile_images.owner_id AND s.expires_at>?`;

export function removeInactiveGuestImage(env: Bindings, user: string, now: number) {
  return env.DB.prepare(`DELETE FROM profile_images WHERE kind='user' AND subject_id=? AND owner_id=?
    AND EXISTS (SELECT 1 FROM users u WHERE u.id=profile_images.owner_id AND u.is_guest=1)
    AND NOT EXISTS (${liveHumanGuest})`).bind(user,user,now);
}

export async function cleanupExpiredHumanGuests(env: Bindings, now: number) {
  const batchSize = 1000;
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM profile_images WHERE rowid IN (
      SELECT profile_images.rowid FROM profile_images JOIN users u ON u.id=profile_images.owner_id
      WHERE profile_images.kind='user' AND u.is_guest=1 AND NOT EXISTS (${liveHumanGuest}) LIMIT ?)`)
      .bind(now,batchSize),
    env.DB.prepare(`DELETE FROM room_members WHERE id IN (
      SELECT m.id FROM room_members m JOIN users u ON u.id=m.user_id
      WHERE m.kind='human' AND u.is_guest=1 AND NOT EXISTS (
        SELECT 1 FROM guest_sessions s JOIN rooms r ON r.id=s.room_id
        WHERE s.user_id=m.user_id AND s.room_id=m.room_id AND s.expires_at>?
          AND r.visibility='public' AND r.access_mode='anonymous') LIMIT ?)`)
      .bind(now,batchSize),
    env.DB.prepare(`DELETE FROM guest_sessions WHERE token_hash IN (
      SELECT s.token_hash FROM guest_sessions s JOIN users u ON u.id=s.user_id
      WHERE u.is_guest=1 AND s.expires_at<=? AND s.csrf_token NOT IN
        ('mcp-joined','mcp-pending','mcp-lobby-joined','mcp-handle') LIMIT ?)`)
      .bind(now,batchSize),
  ]);
}
