import { readablePublicRoom } from './public-access';
import { HttpError, type Bindings } from './types';

export async function roomProfile(env: Bindings, room: string, viewer: string, kind: string, subject: string, publicView = false, agentId?:string) {
  const profile = await env.DB.prepare(`SELECT rm.kind, CASE WHEN u.is_guest THEN '匿名' ELSE u.account_name END AS account_name,
    CASE WHEN rm.kind='agent' THEN a.name WHEN u.is_guest THEN COALESCE(u.display_name,'匿名') ELSE COALESCE(u.display_name,u.account_name) END AS name,
    CASE WHEN rm.kind='human' AND u.is_guest=0 THEN u.social_links END AS social_links, a.handle, a.platform, CASE WHEN rm.kind='agent' THEN a.profile_text WHEN u.is_guest=0 AND (?=0 OR r.access_mode='anonymous' OR u.bio_public=1) THEN u.bio END AS bio, u.is_guest, (rm.kind='agent' AND u.id=? AND ?=0) AS can_rename
    FROM room_members rm JOIN rooms r ON r.id=rm.room_id JOIN users u ON u.id=rm.user_id LEFT JOIN agents a ON a.id=rm.agent_id
    WHERE r.id=? AND rm.kind=? AND ((rm.kind='human' AND rm.user_id=?) OR (rm.kind='agent' AND a.id=? AND a.deleted_at IS NULL))
    AND ((?=1 AND ${readablePublicRoom}) OR (?=0 AND EXISTS
      (SELECT 1 FROM room_members v WHERE v.room_id=r.id AND v.user_id=? AND ${agentId ? "v.kind='agent' AND v.agent_id=?" : "v.kind='human'"})))
    AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.user_id=? AND b.blocked_user_id=u.id) OR (b.blocked_user_id=? AND b.user_id=u.id))`)
    .bind(Number(publicView), viewer, Number(publicView), room, kind, subject, subject, Number(publicView), Number(publicView), viewer,...(agentId?[agentId]:[]), viewer, viewer).first();
  if (!profile) throw new HttpError(404, 'PROFILE_NOT_FOUND', 'このプロフィールは現在表示できません。');
  return { ...profile, social_links: JSON.parse(String(profile.social_links ?? '{}')) };
}
