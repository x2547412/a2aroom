import { z } from 'zod';
import { publicAccessEnabled } from './public-access';
import { parseTags } from './directory';
import { broadcastDirectory } from './directory-hub';
import { validateText } from './domain';
import type { Room } from './store';
import { HttpError, type Bindings, type AgentAuth } from './types';

export const roomMetadataFields = {
  name: z.string().optional().describe('New room name, 1–80 characters.'),
  description: z.string().optional().describe('Up to 500 characters. An empty string clears the description.'),
  tags: z.array(z.string()).optional().describe('Replace all tags, up to five. An empty array clears them.'),
};

type RoomPatch = { name?:string; description?:string; tags?:unknown; directory_listed?:boolean; access_mode?:Room['access_mode'] };
type Editor = {listed:boolean; agent?:never; guestHash?:never} | {agent:AgentAuth; guestHash?:string; listed?:never};

export function roomEditorPredicate(room: Pick<Room,'id'|'host_user_id'>, editor:Editor) {
  let allowed = 'id=? AND host_user_id=?';
  const bindings: (string | number)[] = [room.id, room.host_user_id];
  if (editor.agent) {
    const {agent, connectionId} = editor.agent;
    allowed += ` AND creator_agent_id=? AND host_user_id=? AND EXISTS (
      SELECT 1 FROM agents a JOIN agent_connections c ON c.agent_id=a.id
      JOIN room_members m ON m.agent_id=a.id AND m.room_id=rooms.id AND m.kind='agent'
      WHERE a.id=rooms.creator_agent_id AND a.owner_id=rooms.host_user_id AND c.id=?
        AND a.deleted_at IS NULL AND c.revoked_at IS NULL
        ${editor.guestHash ? '' : 'AND a.autonomous_rooms=1'})`;
    bindings.push(agent.id, agent.owner_id, connectionId);
    if (editor.guestHash) {
      allowed += ` AND visibility='public' AND access_mode='anonymous' AND EXISTS (
        SELECT 1 FROM guest_sessions s WHERE s.token_hash=? AND s.room_id=rooms.id
          AND s.user_id=rooms.host_user_id AND s.expires_at>?)`;
      bindings.push(editor.guestHash, Date.now());
    }
  }

  return {allowed,bindings};
}

export async function updateRoomSettings(env: Bindings, ctx: Pick<ExecutionContext, 'waitUntil'>, room: Room, patch: RoomPatch, editor: Editor) {
  const mode = patch.access_mode;
  const name = patch.name === undefined ? null : validateText(patch.name, 80, 'ルーム名');
  const description = patch.description === undefined ? null : validateText(patch.description, 500, '説明', 0);
  const tags = patch.tags === undefined ? undefined : parseTags(patch.tags);
  if (mode === undefined && name === null && description === null && tags === undefined && patch.directory_listed === undefined)
    throw new HttpError(400, 'EMPTY_ROOM_UPDATE', '変更する項目を指定してください。');

  const {allowed,bindings} = roomEditorPredicate(room,editor);
  if (editor.guestHash && mode !== undefined) throw new HttpError(403,'GUEST_ROOM_ACCESS_FIXED','Guest rooms have anonymous access.');
  if (patch.directory_listed && (!publicAccessEnabled(env) || mode === 'invite'))
    throw new HttpError(400,'LISTING_UNAVAILABLE','Only public rooms can be listed.');
  const listed = mode === 'invite' ? 0 : patch.directory_listed !== undefined ? Number(patch.directory_listed) : editor.listed === undefined ? null : Number(editor.listed);
  const statements = [env.DB.prepare(`UPDATE rooms SET name=COALESCE(?,name), description=COALESCE(?,description),
    access_mode=COALESCE(?,access_mode), visibility=COALESCE(?,visibility), directory_listed=CASE WHEN COALESCE(?,access_mode)='invite' THEN 0 ELSE COALESCE(?,directory_listed) END
    WHERE ${allowed} RETURNING name,description,access_mode,directory_listed`)
    .bind(name,description,mode ?? null,mode ? (mode === 'invite' ? 'invite' : 'public') : null,mode ?? null,listed,...bindings)];
  // D1 keeps the batch atomic. Guard each child-table write too: an unauthorized UPDATE affects zero rows.
  const target = `SELECT id FROM rooms WHERE ${allowed}`;
  if (tags !== undefined) {
    statements.push(env.DB.prepare(`DELETE FROM room_tags WHERE room_id IN (${target})`).bind(...bindings));
    for (const label of tags) {
      statements.push(env.DB.prepare(`INSERT INTO room_tags(room_id,tag_key,label)
        SELECT id,?,? FROM rooms WHERE ${allowed}`).bind(label.toLowerCase(),label,...bindings));
    }
  }
  if (mode && mode !== 'anonymous') {
    statements.push(env.DB.prepare(`DELETE FROM guest_sessions WHERE room_id IN (${target})`).bind(...bindings),
      env.DB.prepare(`DELETE FROM room_members WHERE room_id IN (${target}) AND user_id IN (SELECT id FROM users WHERE is_guest=1)`).bind(...bindings));
  }
  const [update] = await env.DB.batch<Pick<Room,'name'|'description'|'access_mode'|'directory_listed'>>(statements);
  const result = update.results[0];
  if (!result) throw new HttpError(403, 'ROOM_ACCESS_FORBIDDEN', 'このルームの設定は変更できません。');
  if (room.directory_listed || result.directory_listed) ctx.waitUntil(broadcastDirectory(env));
  return {room_id:room.id,...result,directory_listed:Boolean(result.directory_listed),tags};
}
