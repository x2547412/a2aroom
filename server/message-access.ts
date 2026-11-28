import type { AgentAuth } from './types';
import { readablePublicRoom } from './public-access';

export type Actor = {user:string; auth?:AgentAuth; guestHash?:string};
export const agentReviewer = (auth:AgentAuth):Actor => ({user:auth.agent.owner_id, auth, guestHash:auth.guestHash});

export const noBlock = (viewer:string, other:string) => `NOT EXISTS (SELECT 1 FROM blocks b
  WHERE (b.user_id=${viewer} AND b.blocked_user_id=${other}) OR (b.user_id=${other} AND b.blocked_user_id=${viewer}))`;
export const admitted = `NOT EXISTS (SELECT 1 FROM room_expulsions x WHERE x.room_id=r.id AND x.user_id=v.uid)
  AND ${noBlock('v.uid','r.host_user_id')} AND ${noBlock('v.uid','m.author_user_id')}`;

export const actorCte = `actor(uid,aid,conn,hash,policy,key_hash,expires_at) AS (VALUES(?,?,?,?,?,?,?))`;
export const membership = `EXISTS (SELECT 1 FROM room_members rm JOIN users u ON u.id=rm.user_id
  WHERE rm.room_id=r.id AND rm.user_id=v.uid AND rm.agent_id IS v.aid
    AND (v.aid IS NULL OR EXISTS (SELECT 1 FROM agents a JOIN agent_connections c ON c.agent_id=a.id
      WHERE a.id=v.aid AND a.owner_id=v.uid AND a.deleted_at IS NULL AND a.policy_revision=v.policy
        AND c.id=v.conn AND c.revoked_at IS NULL
        AND (v.expires_at IS NULL OR v.expires_at>unixepoch('subsec'))
        AND (v.key_hash IS NULL OR EXISTS (SELECT 1 FROM guest_agent_handles h WHERE h.agent_id=a.id AND h.key_hash=v.key_hash))))
    AND (u.is_guest=0 OR (r.visibility='public' AND r.access_mode='anonymous' AND EXISTS
      (SELECT 1 FROM guest_sessions gs WHERE gs.room_id=r.id AND gs.user_id=v.uid AND gs.token_hash=v.hash
        AND gs.expires_at>unixepoch('subsec')*1000))))`;
export const actorValues = (a:Actor) => [a.user, a.auth?.agent.id ?? null, a.auth?.connectionId ?? null, a.guestHash ?? null, a.auth?.agent.policy_revision ?? null, a.auth?.guestKeyHash ?? null, a.auth?.expiresAt ?? null];
export const target = `WITH ${actorCte}, target AS (
  SELECT m.id, m.seq, m.room_id, m.author_user_id=v.uid AND m.author_agent_id IS v.aid AS own
  FROM messages m JOIN rooms r ON r.id=m.room_id CROSS JOIN actor v
  WHERE r.id=? AND m.id=? AND m.deleted_at IS NULL AND ${admitted} AND ${membership})`;

export const listedViewers = `WITH guest_viewers AS (
    SELECT gs.room_id,gs.user_id FROM guest_sessions gs WHERE gs.token_hash IN (SELECT value FROM json_each(?))
      AND gs.expires_at>unixepoch('subsec')*1000 GROUP BY gs.room_id),
    viewers AS (SELECT r.id AS room_id,COALESCE(NULLIF(?,''),gv.user_id,'') AS uid FROM rooms r
      LEFT JOIN guest_viewers gv ON gv.room_id=r.id WHERE r.directory_listed=1 AND ${readablePublicRoom})`;
