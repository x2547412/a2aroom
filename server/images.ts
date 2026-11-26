import { readablePublicRoom } from './public-access';
import { configuredOwnerId } from './account-names';
import type { AgentAuth, Bindings, User } from './types';
import { HttpError } from './types';
import { checkAgentConnection, ownedAgent } from './store';
import { sha256 } from './security';

export type ImageKind = 'user' | 'agent' | 'platform';
export type AgentImageKind = 'agent' | 'platform';

export function imageKind(value: string): ImageKind {
  if (value === 'user' || value === 'agent' || value === 'platform') return value;
  throw new HttpError(404, 'IMAGE_NOT_FOUND', '画像が見つかりません。');
}

export async function requireImageOwner(env: Bindings, user: User, kind: ImageKind, subjectId: string): Promise<void> {
  if (kind === 'user') {
    if (subjectId !== user.id) throw new HttpError(403, 'IMAGE_FORBIDDEN', 'この画像は変更できません。');
  } else {
    await ownedAgent(env, user.id, subjectId);
  }
}

// Shared-room membership is required for other users' images; blocked owners are hidden.
const visibleImage = `(i.owner_id = ? OR (
  NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.user_id = ? AND b.blocked_user_id = i.owner_id)
    OR (b.blocked_user_id = ? AND b.user_id = i.owner_id))
  AND EXISTS (SELECT 1 FROM room_members viewer JOIN room_members subject ON subject.room_id = viewer.room_id
    WHERE viewer.user_id = ? AND viewer.kind = 'human'
    AND ((i.kind = 'user' AND subject.kind = 'human' AND subject.user_id = i.subject_id)
      OR (i.kind IN ('agent', 'platform') AND subject.kind = 'agent' AND subject.agent_id = i.subject_id)))
))`;

export async function visibleImages(env: Bindings, userId: string): Promise<Array<{ kind: ImageKind; subject_id: string; updated_at: number }>> {
  const result = await env.DB.prepare(`SELECT i.kind, i.subject_id, i.updated_at FROM profile_images i WHERE ${visibleImage}`)
    .bind(userId, userId, userId, userId).all<{ kind: ImageKind; subject_id: string; updated_at: number }>();
  return result.results;
}

export async function visibleImageData(env: Bindings, userId: string, kind: ImageKind, subjectId: string): Promise<{ mime_type: string; image_data: number[] } | null> {
  return env.DB.prepare(`SELECT i.mime_type, i.image_data FROM profile_images i WHERE i.kind = ? AND i.subject_id = ? AND ${visibleImage}`)
    .bind(kind, subjectId, userId, userId, userId, userId).first<{ mime_type: string; image_data: number[] }>();
}

const roomImage = `EXISTS (SELECT 1 FROM room_members rm JOIN rooms r ON r.id = rm.room_id
  WHERE rm.room_id = ? AND ${readablePublicRoom}
  AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.user_id=? AND b.blocked_user_id=rm.user_id)
    OR (b.blocked_user_id=? AND b.user_id=rm.user_id))
  AND ((i.kind = 'user' AND rm.kind = 'human' AND rm.user_id = i.subject_id)
    OR (i.kind IN ('agent', 'platform') AND rm.kind = 'agent' AND rm.agent_id = i.subject_id)))`;

export async function publicRoomImages(env: Bindings, roomId: string, viewer: string): Promise<Array<{ kind: ImageKind; subject_id: string; updated_at: number }>> {
  const result = await env.DB.prepare(`SELECT i.kind, i.subject_id, i.updated_at FROM profile_images i WHERE ${roomImage}`)
    .bind(roomId, viewer, viewer).all<{ kind: ImageKind; subject_id: string; updated_at: number }>();
  return result.results;
}

export async function publicRoomImageData(env: Bindings, roomId: string, kind: ImageKind, subjectId: string, viewer: string): Promise<{ mime_type: string; image_data: number[] } | null> {
  return env.DB.prepare(`SELECT i.mime_type, i.image_data FROM profile_images i WHERE i.kind = ? AND i.subject_id = ? AND ${roomImage}`)
    .bind(kind, subjectId, roomId, viewer, viewer).first<{ mime_type: string; image_data: number[] }>();
}

function rasterDimensions(bytes: Uint8Array, mime: string): [number, number] | null {
  const ascii = (start: number, length: number) => String.fromCharCode(...bytes.slice(start, start + length));
  const be32 = (offset: number) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset);
  const le32 = (offset: number) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
  if (mime === 'image/png') {
    if (bytes.length < 45 || ![137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) return null;
    let width = 0; let height = 0; let data = false; let ended = false;
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = be32(offset); if (length > bytes.length - offset - 12) return null;
      const type = ascii(offset + 4, 4);
      if (offset === 8) { if (type !== 'IHDR' || length !== 13) return null; width = be32(offset + 8); height = be32(offset + 12); }
      if (type === 'acTL') return null;
      if (type === 'IDAT') data = true;
      offset += length + 12;
      if (type === 'IEND') { ended = length === 0 && offset === bytes.length; break; }
    }
    return data && ended ? [width, height] : null;
  }
  if (mime === 'image/webp') {
    if (bytes.length < 25 || ascii(0, 4) !== 'RIFF' || ascii(8, 4) !== 'WEBP' || le32(4) + 8 !== bytes.length) return null;
    const type = ascii(12, 4);
    if (type === 'VP8X' && bytes.length >= 30 && !(bytes[20] & 2)) {
      return [1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16), 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16)];
    }
    if (type === 'VP8L' && bytes[20] === 0x2f) {
      return [1 + bytes[21] + ((bytes[22] & 0x3f) << 8), 1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 0x0f) << 10)];
    }
    if (type === 'VP8 ' && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 1 && bytes[25] === 0x2a) {
      return [(bytes[26] | bytes[27] << 8) & 0x3fff, (bytes[28] | bytes[29] << 8) & 0x3fff];
    }
    return null;
  }
  if (mime === 'image/jpeg') {
    if (bytes.length < 12 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) return null;
    for (let offset = 2; offset + 4 <= bytes.length;) {
      if (bytes[offset++] !== 0xff) return null;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) return null;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) return null;
      const length = (bytes[offset] << 8) | bytes[offset + 1];
      if (length < 2 || offset + length > bytes.length) return null;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (length < 8) return null;
        return [(bytes[offset + 5] << 8) | bytes[offset + 6], (bytes[offset + 3] << 8) | bytes[offset + 4]];
      }
      offset += length;
    }
  }
  return null;
}

export function optionalImage(value: unknown) {
  return value === undefined ? null : parseImage(value && typeof value === 'object' ? value as Record<string, unknown> : {});
}

export function parseImage(body: Record<string, unknown>): { mime: string; bytes: Uint8Array } {
  const mime = body.mime;
  const encoded = body.data;
  if ((mime !== 'image/png' && mime !== 'image/jpeg' && mime !== 'image/webp') || typeof encoded !== 'string' || encoded.length > 54_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new HttpError(400, 'INVALID_IMAGE', '画像の形式またはサイズを確認してください。');
  }
  let binary: string;
  try { binary = atob(encoded); } catch { throw new HttpError(400, 'INVALID_IMAGE', '画像を読み込めませんでした。'); }
  if (!binary.length || binary.length > 40_000) throw new HttpError(400, 'INVALID_IMAGE', '画像のサイズを確認してください。');
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const dimensions = rasterDimensions(bytes, mime);
  if (!dimensions || dimensions.some((value) => value < 1 || value > 512)) {
    throw new HttpError(400, 'INVALID_IMAGE', '画像の形式を確認してください。');
  }
  return { mime, bytes };
}

async function enforceAgentImageRate(env: Bindings, agentId: string): Promise<void> {
  const now = Date.now();
  const key = await sha256(`agent-image:${agentId}`);
  const result = await env.DB.prepare(`INSERT INTO login_attempts (subject_hash, created_at)
    SELECT ?, ? WHERE (SELECT COUNT(*) FROM login_attempts WHERE subject_hash = ? AND created_at > ?) < 30`)
    .bind(key, now, key, now - 60 * 60_000).run();
  if (!result.meta.changes) throw new HttpError(429, 'IMAGE_RATE_LIMIT', '画像の変更回数が上限に達しました。');
}

const activeConnection = `EXISTS (SELECT 1 FROM agent_connections c JOIN agents a ON a.id = c.agent_id
  JOIN users u ON u.id = a.owner_id WHERE c.id = ? AND a.id = ? AND a.owner_id = ?
  AND c.revoked_at IS NULL AND a.deleted_at IS NULL AND (? <> 'true' OR u.id=${configuredOwnerId}))`;

export async function setAgentImage(env: Bindings, auth: AgentAuth, kind: AgentImageKind, body: Record<string, unknown>): Promise<{ kind: AgentImageKind; updated_at: number }> {
  await enforceAgentImageRate(env, auth.agent.id);
  const image = parseImage(body);
  const row = await env.DB.prepare(`INSERT INTO profile_images (kind, subject_id, owner_id, mime_type, image_data, updated_at)
    SELECT ?, ?, ?, ?, ?, ? WHERE ${activeConnection}
    ON CONFLICT(kind, subject_id) DO UPDATE SET mime_type = excluded.mime_type, image_data = excluded.image_data,
      updated_at = MAX(profile_images.updated_at + 1, excluded.updated_at)
    WHERE profile_images.owner_id = excluded.owner_id RETURNING updated_at`)
    .bind(kind, auth.agent.id, auth.agent.owner_id, image.mime, image.bytes.buffer, Date.now(),
      auth.connectionId, auth.agent.id, auth.agent.owner_id, env.PRIVATE_BETA, env.OWNER_ACCOUNT)
    .first<{ updated_at: number }>();
  if (!row) throw new HttpError(401, 'TOKEN_REVOKED', '接続が失効しています。');
  return { kind, updated_at: row.updated_at };
}

export async function removeAgentImage(env: Bindings, auth: AgentAuth, kind: AgentImageKind): Promise<{ kind: AgentImageKind; removed: boolean }> {
  await enforceAgentImageRate(env, auth.agent.id);
  const result = await env.DB.prepare(`DELETE FROM profile_images WHERE kind = ? AND subject_id = ? AND owner_id = ?
    AND ${activeConnection}`)
    .bind(kind, auth.agent.id, auth.agent.owner_id, auth.connectionId, auth.agent.id, auth.agent.owner_id, env.PRIVATE_BETA, env.OWNER_ACCOUNT).run();
  if (!result.meta.changes) await checkAgentConnection(env, auth.agent.id, auth.connectionId, auth.agent.owner_id);
  return { kind, removed: Boolean(result.meta.changes) };
}
