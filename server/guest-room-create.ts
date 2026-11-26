import { optionalImage } from './images';
import { validateText } from './domain';
import { parseTags, writeTags } from './directory';
import type { Bindings } from './types';

export const guestLifetime = 7 * 86400_000;

export async function createGuestRoom(env: Bindings, room: string, user: string, kind: 'agent'|'human',
  input: {name:unknown;display_name:unknown;description?:unknown;tags?:unknown;image?:unknown;directory_listed?:boolean},
  hash: string, csrf: string) {
  const name = validateText(input.name,80,'ルーム名');
  const description = validateText(input.description ?? '',500,'説明',0);
  const display = validateText(input.display_name,40,'表示名');
  const photo = kind === 'human' ? optionalImage(input.image) : null;
  const tags = parseTags(input.tags ?? []);
  const now = Date.now(), db = env.DB;
  await db.batch([
    db.prepare(`INSERT INTO users(id,account_name,email,display_name,is_guest,created_at) SELECT ?,?,?,?,1,?
      ${kind==='agent' ? 'WHERE EXISTS (SELECT 1 FROM guest_room_requests WHERE token_hash=? AND user_id=? AND room_id=? AND expires_at>?)' : ''}`)
      .bind(user,'guest-'+(kind==='agent'?'ai-':'')+user,user+'@guest.invalid',display,now,...(kind==='agent'?[hash,user,room,now]:[])),
    ...(kind==='agent' ? [
      db.prepare("INSERT INTO agents(id,owner_id,name,platform,handle,created_at) VALUES(?,?,?,'AI','guest',?)").bind(user,user,display,now),
      db.prepare("INSERT INTO agent_connections(id,agent_id,label,kind,created_at) VALUES(?,?,'Guest MCP','token',?)").bind(user,user,now),
    ]:[]),
    db.prepare("INSERT INTO rooms(id,host_user_id,creator_agent_id,name,description,visibility,access_mode,directory_listed,created_at) VALUES(?,?,?,?,?,'public','anonymous',?,?)")
      .bind(room,user,kind==='agent'?user:null,name,description,Number(input.directory_listed ?? true),now),
    db.prepare('INSERT INTO room_members(id,room_id,user_id,agent_id,kind,joined_at) VALUES(?,?,?,?,?,?)')
      .bind(crypto.randomUUID(),room,user,kind==='agent'?user:null,kind,now),
    db.prepare('INSERT INTO guest_sessions(token_hash,user_id,room_id,csrf_token,expires_at,created_at) VALUES(?,?,?,?,?,?)')
      .bind(hash,user,room,csrf,now+guestLifetime,now),
    ...(photo ? [db.prepare(`INSERT INTO profile_images(kind,subject_id,owner_id,mime_type,image_data,updated_at)
      VALUES('user',?,?,?,?,?)`).bind(user,user,photo.mime,photo.bytes.buffer,now)] : []),
    ...writeTags(env,room,tags),
    ...(kind==='agent'?[db.prepare('DELETE FROM guest_room_requests WHERE token_hash=?').bind(hash)]:[]),
  ]);
}
