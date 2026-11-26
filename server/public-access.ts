import { directoryAppOrigin, directoryOrigin } from '../shared/directory';
import { HttpError, type Bindings } from './types';

export const stagingOrigin = 'https://staging.a2aroom.com';
export function publicAccessEnabled(env: Bindings): boolean {
  if (env.PRIVATE_BETA !== 'false' || env.PUBLIC_ACCESS !== 'true') return false;
  return env.ENVIRONMENT === 'development' || (env.ENVIRONMENT === 'production' &&
    (env.PUBLIC_ORIGIN === stagingOrigin || isDirectoryDeployment(env)));
}

export function isDirectoryDeployment(env: Bindings) {
  return env.PUBLIC_ORIGIN === directoryAppOrigin && env.DIRECTORY_ORIGIN === directoryOrigin;
}

export function isDirectoryHost(url: URL, env: Bindings) {
  return env.DIRECTORY_ORIGIN === directoryOrigin && env.PUBLIC_ORIGIN === directoryAppOrigin && url.hostname === new URL(directoryOrigin).hostname;
}

// Anonymous rooms are accessible by direct link. Listing also opens read access for registered rooms.
export const readablePublicRoom = `r.visibility='public' AND
  (r.access_mode='anonymous' OR (r.access_mode='registered' AND r.directory_listed=1))`;

export const guestAccess = `EXISTS (SELECT 1 FROM guest_sessions gs JOIN rooms r ON r.id=gs.room_id
  JOIN room_members rm ON rm.room_id=r.id AND rm.user_id=gs.user_id AND rm.kind='agent'
  WHERE gs.token_hash=? AND r.id=? AND rm.agent_id=? AND gs.expires_at>unixepoch('subsec')*1000
  AND r.visibility='public' AND r.access_mode='anonymous')`;

// The viewer expression is a bound parameter or a trusted SQL column.
export function roomAudience(viewer: '?3' | 'h.agent_id') {
  return `NOT EXISTS (SELECT 1 FROM room_expulsions x WHERE x.room_id=r.id AND x.user_id=${viewer})
    AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.user_id=${viewer} AND b.blocked_user_id=r.host_user_id)
      OR (b.blocked_user_id=${viewer} AND b.user_id=r.host_user_id))`;
}

export async function lookupRoom(env: Bindings, roomId: string, viewer: string, preview: boolean) {
  const room = await env.DB.prepare(`SELECT r.id, r.name, r.description, r.visibility, r.access_mode, r.directory_listed, r.created_at,
    r.host_user_id, CASE WHEN u.is_guest=1 THEN u.display_name END AS host_display_name, CASE WHEN u.is_guest=1 THEN '匿名' ELSE u.account_name END AS host_account,
    (SELECT COUNT(*) FROM room_members rm JOIN users member ON member.id=rm.user_id WHERE rm.room_id=r.id AND
      (member.is_guest=0 OR EXISTS (SELECT 1 FROM guest_sessions gs WHERE gs.user_id=rm.user_id AND gs.room_id=r.id AND gs.expires_at>?))) AS member_count
    FROM rooms r JOIN users u ON u.id = r.host_user_id
    WHERE r.id = ? AND ${preview ? readablePublicRoom : "r.visibility='public' AND r.access_mode='anonymous'"}
    AND ${roomAudience('?3')}`).bind(Date.now(), roomId, viewer).first();
  if (!room) throw new HttpError(404, 'ROOM_NOT_FOUND', 'ルームが見つかりません。');
  return room;
}

export function guestRoomScope(hash:string|undefined, room:string, agent:string) {
  return hash ? {sql:' AND '+guestAccess,args:[hash,room,agent]} : {sql:'',args:[]};
}
