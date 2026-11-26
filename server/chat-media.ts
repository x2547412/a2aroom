import { guestRoomScope, readablePublicRoom } from './public-access';
import { maxFiles, maxFileBytes, reactions, stickers, uploadLimitLabel, type Attachment, type Reaction, type StickerId } from '../shared/chat';
import { Buffer } from 'node:buffer';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { sha256 } from './security';
import { HttpError, type AgentAuth, type Bindings, type User } from './types';

export type RichMessage = { uploads: File[]; files: Attachment[]; sticker: StickerId | null; labelOnly: boolean; fallback: string; requestId: string };
const mediaKey = (id: string) => 'chat/' + id;

async function describe(file: File): Promise<Attachment> {
  const head = new Uint8Array(await file.slice(0, 40).arrayBuffer());
  const tag = String.fromCharCode(...head);
  let mime = 'application/octet-stream';
  if (tag.startsWith('\x89PNG\r\n\x1a\n')) mime = 'image/png';
  else if (tag.startsWith('\xff\xd8\xff')) mime = 'image/jpeg';
  else if (/^GIF8[79]a/.test(tag)) mime = 'image/gif';
  else if (tag.startsWith('RIFF') && tag.slice(8, 12) === 'WEBP') mime = 'image/webp';
  else if (tag.slice(4, 8) === 'ftyp') {
    const brand = tag.slice(8, 12);
    if (/^(avif|avis)$/.test(brand)) mime = 'image/avif';
    else if (/^(heic|heix|hevc|hevx|mif1|msf1)$/.test(brand)) mime = 'image/heic';
    else if (brand === 'qt  ') mime = 'video/quicktime';
    else if (/^(isom|iso[2-9]|mp4[12]|avc1|M4V |MSNV|dash)$/.test(brand)) mime = 'video/mp4';
  } else if (tag.startsWith('\x1a\x45\xdf\xa3') && file.type === 'video/webm') mime = 'video/webm';
  const name = Array.from(file.name.split(/[\\/]/).pop() || 'ファイル').filter(c => c.charCodeAt(0) >= 32 && !/[\u007f\u202a-\u202e\u2066-\u2069]/.test(c)).slice(0,180).join('') || 'ファイル';
  const kind = mime.startsWith('image/') ? 'photo' : mime.startsWith('video/') ? 'video' : 'file';
  return { id: crypto.randomUUID(), name, mime, kind, size: file.size };
}

export async function prepareUpload(request: Request) {
  let form: FormData;
  try { form = await request.formData(); } catch { throw new HttpError(400,'INVALID_FORM','添付を読み込めませんでした。'); }
  const text = form.get('body') ?? '';
  const reply = form.get('reply_to');
  const requestId = form.get('request_id');
  return prepareMedia(text,reply,requestId,form.getAll('files'),form.get('sticker'));
}

export async function prepareMedia(text:FormDataEntryValue,reply:FormDataEntryValue|null,requestId:FormDataEntryValue|null,
  entries:FormDataEntryValue[],stickerValue:FormDataEntryValue|null) {
  if (typeof text !== 'string' || [...text].length > 4000 || (reply !== null && typeof reply !== 'string') ||
      typeof requestId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(requestId)) {
    throw new HttpError(400,'INVALID_MESSAGE','送信内容を確認してください。');
  }
  const files = entries.filter((f): f is File => typeof f !== 'string');
  if (entries.length !== files.length || files.length > maxFiles || files.some(f => f.size === 0) || files.reduce((s,f) => s + f.size, 0) > maxFileBytes)
    throw new HttpError(400,'INVALID_FILES',uploadLimitLabel);
  const sticker = stickers.find(s => s.id === stickerValue);
  if ((stickerValue !== null && !sticker) || (!files.length && !sticker)) throw new HttpError(400,'INVALID_MEDIA','添付またはスタンプを選んでください。');
  const metadata = await Promise.all(files.map(describe));
  const fallback = sticker ? `スタンプ「${sticker.label}」` : metadata.length === 1 ? metadata[0].name : `添付ファイル ${metadata.length}件`;
  return { body: text, reply, media: { uploads: files, files: metadata, sticker: sticker?.id ?? null, labelOnly: !text.trim(), fallback, requestId } };
}

export async function storeUpload(env: Bindings, media: RichMessage, caption: string, replyTo: string | null) {
  if (media.files.length) {
    const expires = Date.now() + 3600_000;
    await env.DB.batch(media.files.map(file =>
      env.DB.prepare('INSERT INTO media_cleanup(id,due_at) VALUES(?,?)').bind(file.id, expires)));
  }
  const contents: string[][] = [];
  for (const [index, file] of media.files.entries()) {
    const stored = await env.CHAT_MEDIA.put(mediaKey(file.id), media.uploads[index]);
    if (!stored) throw new HttpError(503, 'UPLOAD_FAILED', '添付を保存できませんでした。もう一度送信してください。');
    contents.push([file.name, stored.etag]);
  }
  // Distinct photos with the same filename or caption are valid consecutive posts.
  return sha256(JSON.stringify([caption, replyTo, media.sticker, contents]));
}

export async function cleanupMedia(env: Bindings) {
  const due = await env.DB.prepare('SELECT id FROM media_cleanup WHERE due_at <= ? ORDER BY due_at LIMIT 80').bind(Date.now()).all<{id: string}>();
  if (!due.results.length) return;
  const ids = due.results.map(row => row.id);
  await env.CHAT_MEDIA.delete(ids.map(mediaKey));
  await env.DB.prepare(`DELETE FROM media_cleanup WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).run();
}

export async function messageExtras(env: Bindings, viewer: string, ids: string[], agentId: string | null = null) {
  const files = new Map<string, Attachment[]>();
  const counts = new Map<string, Reaction[]>();
  // read_messages supports 100 results; keep room for D1's fixed parameters.
  for (let i = 0; i < ids.length; i += 80) {
    const page = ids.slice(i, i + 80);
    const args = page.map(() => '?').join(',');
    const [attachments, grouped] = await env.DB.batch([
      env.DB.prepare(`SELECT id,message_id,name,mime,kind,size FROM message_attachments WHERE message_id IN (${args}) ORDER BY position`).bind(...page),
      env.DB.prepare(`SELECT r.message_id,r.emoji,COUNT(*) AS count,MAX(r.user_id=? AND r.agent_id IS ?) AS mine FROM room_message_reactions r
        WHERE r.message_id IN (${args}) AND NOT EXISTS (SELECT 1 FROM blocks b WHERE
        (b.user_id=? AND b.blocked_user_id=r.user_id) OR (b.blocked_user_id=? AND b.user_id=r.user_id))
        GROUP BY r.message_id,r.emoji ORDER BY count DESC,r.emoji`).bind(viewer, agentId, ...page, viewer, viewer),
    ]);
    for (const row of attachments.results as (Attachment & {message_id:string})[]) {
      const { message_id, ...file } = row;
      const list = files.get(message_id) ?? []; list.push(file); files.set(message_id, list);
    }
    for (const row of grouped.results as {message_id:string; emoji:string; count:number; mine:number}[]) {
      const list = counts.get(row.message_id) ?? [];
      list.push({ emoji: row.emoji, count: row.count, mine: Boolean(row.mine) }); counts.set(row.message_id, list);
    }
  }
  return { files, counts };
}

const reactionTarget = `SELECT m.id FROM messages m JOIN rooms r ON r.id=m.room_id
      JOIN room_members rm ON rm.room_id=m.room_id AND rm.user_id=? AND rm.kind='human' JOIN users u ON u.id=rm.user_id
      WHERE m.id=? AND m.room_id=? AND m.deleted_at IS NULL AND (u.is_guest=0 OR r.access_mode='anonymous')
      AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.user_id=u.id AND b.blocked_user_id=m.author_user_id)
      OR (b.blocked_user_id=u.id AND b.user_id=m.author_user_id))`;

export async function setReaction(env: Bindings, user: User, roomId: string, messageId: string, emoji: unknown) {
  if (emoji !== null && !reactions.some(r => r.emoji === emoji)) throw new HttpError(400,'INVALID_REACTION','リアクションを選んでください。');
  // Repeat the visibility predicate in the write, so a concurrent removal cannot add a reaction.
  const visible = await env.DB.prepare(reactionTarget).bind(user.id,messageId,roomId).first();
  if (!visible) throw new HttpError(404,'MESSAGE_NOT_FOUND','発言が見つかりません。');
  if (emoji === null) await env.DB.prepare('DELETE FROM message_reactions WHERE message_id=? AND user_id=?').bind(messageId,user.id).run();
  else {
    const result = await env.DB.prepare(`INSERT INTO message_reactions(message_id,user_id,emoji)
      SELECT id,?,? FROM (${reactionTarget}) WHERE true
      ON CONFLICT(message_id,user_id) DO UPDATE SET emoji=excluded.emoji`).bind(user.id,emoji,user.id,messageId,roomId).run();
    if (!result.meta.changes) throw new HttpError(404,'MESSAGE_NOT_FOUND','発言が見つかりません。');
  }
  return (await messageExtras(env,user.id,[messageId])).counts.get(messageId) ?? [];
}

export async function setAgentReaction(env: Bindings, auth: AgentAuth, room: string, message: string, emoji: string | null) {
  const guest=guestRoomScope(auth.guestHash,room,auth.agent.id);
  const targetSql = `SELECT m.id FROM messages m
    JOIN room_members rm ON rm.room_id=m.room_id AND rm.kind='agent' AND rm.agent_id=?
    JOIN agent_connections c ON c.agent_id=rm.agent_id AND c.id=? AND c.revoked_at IS NULL
    JOIN agents a ON a.id=rm.agent_id AND a.deleted_at IS NULL AND a.owner_id=?
    WHERE m.id=? AND m.room_id=? AND m.deleted_at IS NULL AND NOT EXISTS
    (SELECT 1 FROM blocks b WHERE (b.user_id=a.owner_id AND b.blocked_user_id=m.author_user_id)
      OR (b.blocked_user_id=a.owner_id AND b.user_id=m.author_user_id))${guest.sql}`;
  const args = [auth.agent.id, auth.connectionId, auth.agent.owner_id, message, room,...guest.args];
  // D1 executes the authorization check and the conditional mutation in one transaction.
  const eligible = `EXISTS (${targetSql})`;
  const write = emoji === null
    ? env.DB.prepare(`DELETE FROM agent_reactions WHERE message_id=? AND agent_id=? AND ${eligible}`).bind(message, auth.agent.id, ...args)
    : env.DB.prepare(`INSERT INTO agent_reactions(message_id,agent_id,emoji)
        SELECT ?,?,? WHERE ${eligible} ON CONFLICT(message_id,agent_id) DO UPDATE SET emoji=excluded.emoji`)
        .bind(message, auth.agent.id, emoji, ...args);
  const [visible] = await env.DB.batch([env.DB.prepare(targetSql).bind(...args), write]);
  if (!visible.results.length) throw new HttpError(404, 'MESSAGE_NOT_FOUND', 'Message unavailable in this room.');
  return { reactions: (await messageExtras(env, auth.agent.owner_id, [message], auth.agent.id)).counts.get(message) ?? [] };
}

function requestedRange(header: string, size: number) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && start <= end && start < size ? { start, end } : null;
}

async function visibleAttachment(env: Bindings, viewer: string, room: string, id: string, access: 'public' | 'human' | { agentId: string }) {
  let scope = readablePublicRoom;
  const params = [id, room];
  if (access !== 'public') {
    const agent = typeof access === 'object';
    scope = `EXISTS (SELECT 1 FROM room_members rm WHERE rm.room_id=r.id AND rm.user_id=? AND ${agent ? "rm.kind='agent' AND rm.agent_id=?" : "rm.kind='human'"})`;
    params.push(viewer);
    if (agent) params.push(access.agentId);
  }
  const file = await env.DB.prepare(`SELECT a.id,a.name,a.mime,a.kind,a.size FROM message_attachments a
    JOIN messages m ON a.message_id=m.id JOIN rooms r ON r.id=m.room_id
    WHERE a.id=? AND r.id=? AND m.deleted_at IS NULL AND ${scope}
    AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.user_id=? AND b.blocked_user_id=m.author_user_id)
      OR (b.blocked_user_id=? AND b.user_id=m.author_user_id))`)
    .bind(...params,viewer,viewer).first<Attachment>();
  if (!file) throw new HttpError(404,'FILE_NOT_FOUND','添付が見つかりません。');
  return file;
}

export async function readAgentAttachment(env: Bindings, owner: string, agent: string, room: string, id: string, offset?: number, publicView=false): Promise<CallToolResult> {
  const access = publicView ? 'public' : { agentId: agent };
  const file = await visibleAttachment(env, owner, room, id, access);
  if (offset === undefined && file.size > 4 * 1024 * 1024)
    throw new HttpError(413, 'USE_CHUNKS', '4MiBを超える添付です。offset=0から順に取得し、結合して開いてください。');
  if (offset !== undefined && offset >= file.size)
    throw new HttpError(416, 'INVALID_OFFSET', '添付の範囲外です。');
  const length = offset === undefined ? file.size : Math.min(512 * 1024, file.size - offset);
  const object = await env.CHAT_MEDIA.get(mediaKey(id), offset === undefined ? {} : { range: { offset, length } });
  if (!object) throw new HttpError(404, 'FILE_NOT_FOUND', '添付が見つかりません。');
  const blob = Buffer.from(await object.arrayBuffer()).toString('base64');
  await visibleAttachment(env, owner, room, id, access);
  if (offset === undefined && file.kind === 'photo')
    return { content: [{ type: 'image', mimeType: file.mime, data: blob }] };
  const uri = `a2aroom://rooms/${encodeURIComponent(room)}/attachments/${encodeURIComponent(id)}`;
  const end = (offset ?? 0) + length;
  return { content: [
    { type: 'text', text: JSON.stringify({ name: file.name, mime: file.mime, size: file.size, offset: offset ?? 0, next_offset: end < file.size ? end : null }) },
    { type: 'resource', resource: { uri: offset === undefined ? uri : uri + '?offset=' + offset, mimeType: offset === undefined ? file.mime : 'application/octet-stream', blob } },
  ] };
}

export async function serveAttachment(env: Bindings, viewer: string, room: string, id: string, request: Request, isPublic = false) {
  const file = await visibleAttachment(env, viewer, room, id, isPublic ? 'public' : 'human');
  const rangeHeader = request.headers.get('Range');
  const range = rangeHeader ? requestedRange(rangeHeader,file.size) : null;
  if (rangeHeader && !range) return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + file.size } });
  const download = file.kind === 'file' || new URL(request.url).searchParams.has('download');
  const headers = new Headers({
    'Content-Type': download ? 'application/octet-stream' : file.mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store',
    'Content-Disposition': (download ? 'attachment' : 'inline') + "; filename*=UTF-8''" + encodeURIComponent(file.name).replace(/['()*]/g,c => '%' + c.charCodeAt(0).toString(16)),
    'Content-Length': String(range ? range.end - range.start + 1 : file.size),
  });
  if (range) headers.set('Content-Range', `bytes ${range.start}-${range.end}/${file.size}`);
  if (request.method === 'HEAD') return new Response(null,{ headers, status: range ? 206 : 200 });
  const object = await env.CHAT_MEDIA.get(mediaKey(id),range ? {range:{offset:range.start,length:range.end-range.start+1}} : {});
  if (!object) throw new HttpError(404,'FILE_NOT_FOUND','添付が見つかりません。');
  return new Response(object.body,{ headers, status: range ? 206 : 200 });
}
