import { createGuestRoom, guestLifetime } from './guest-room-create';
import { guestMcp } from './guest-mcp';
import { replyingParticipants, setHumanReplyStatus } from './reply-status';
import { prepareUpload, serveAttachment, setReaction } from './chat-media';
import { roomDirectoryChanged } from './directory-hub';
import { latestIncoming, subscribeInbox } from './message-inbox';
import { signalMessage } from './wakes';
import { Hono } from 'hono';
import type { Bindings, Session } from './types';
import { HttpError } from './types';
import { enforceIpRate, getSession, parseCookies, randomToken, requireCsrf, requireOrigin, sha256 } from './security';
import { publicAccessEnabled, lookupRoom } from './public-access';
import { postHumanMessage } from './store';
import { roomProfile } from './room-profiles';
import { recordHumanReads, roomMessagePage, roomTimelinePage } from './messages';
import { optionalImage, parseImage, imageKind, publicRoomImageData, publicRoomImages } from './images';
import { validateText } from './domain';

export const publicApi = new Hono<{ Bindings: Bindings }>();
const GUEST_COOKIE = '__Host-a2aroom_guest';
const GUEST_TTL = guestLifetime;

publicApi.use('*', async (c, next) => {
  if (!publicAccessEnabled(c.env)) throw new HttpError(404, 'NOT_FOUND', 'ページが見つかりません。');
  await next();
});

function anonymousRoom(env: Bindings, roomId: string) {
  return lookupRoom(env, roomId, '', false);
}

async function previewRoom(request: Request, env: Bindings, roomId: string) {
  const account = await getSession(request, env);
  const guest = account ? null : await guestSession(request, env, roomId);
  const viewer = account?.user.id ?? guest?.user.id ?? '';
  const room = await lookupRoom(env, roomId, viewer, true);
  return { room, viewer, guest };
}

async function guestSession(request: Request, env: Bindings, roomId: string): Promise<Session | null> {
  const cookies = parseCookies(request.headers.get('Cookie'));
  const token = cookies[GUEST_COOKIE+'_'+roomId] ?? cookies[GUEST_COOKIE];
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const row = await env.DB.prepare(`SELECT u.id, u.display_name, s.csrf_token, s.token_hash FROM guest_sessions s
    JOIN users u ON u.id = s.user_id AND u.is_guest = 1
    JOIN rooms r ON r.id = s.room_id AND r.visibility = 'public' AND r.access_mode = 'anonymous'
    JOIN room_members rm ON rm.room_id = s.room_id AND rm.user_id = s.user_id AND rm.kind = 'human'
    WHERE s.token_hash = ? AND s.room_id = ? AND s.expires_at > ?`)
    .bind(await sha256(token), roomId, Date.now()).first<{ id: string; display_name: string | null; csrf_token: string; token_hash: string }>();
  return row ? { operator: false, user: { id: row.id, account_name: '匿名', display_name: row.display_name, email: '' }, csrf: row.csrf_token, tokenHash: row.token_hash } : null;
}

async function body(request: Request, allowEmpty = false): Promise<Record<string, unknown>> {
  try {
    const raw = await request.text();
    if (allowEmpty && !raw) return {};
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid');
    return value as Record<string, unknown>;
  } catch { throw new HttpError(400, 'INVALID_BODY', '入力内容を確認してください。'); }
}

publicApi.get('/rooms', async (c) => {
  await enforceIpRate(c.env, c.req.raw, 'public-directory', 600, 60 * 60_000);
  const rooms = await c.env.DB.prepare(`SELECT r.id, r.name, r.description, r.access_mode, r.created_at, CASE WHEN u.is_guest=1 THEN '匿名' ELSE u.account_name END AS host_account
    FROM rooms r JOIN users u ON u.id = r.host_user_id WHERE r.directory_listed=1 AND r.visibility = 'public' AND r.access_mode = 'anonymous'
    ORDER BY r.created_at DESC LIMIT 100`).all();
  return c.json({ rooms: rooms.results });
});

publicApi.get('/rooms/:id', async (c) => c.json({ room: (await previewRoom(c.req.raw, c.env, c.req.param('id'))).room }));

publicApi.all('/mcp', c => guestMcp(c.req.raw,c.env,c.executionCtx,null));

publicApi.post('/rooms', async c => {
  requireOrigin(c.req.raw,c.env);
  const input = await body(c.req.raw);
  const key = input.request_id ?? crypto.randomUUID();
  if (typeof key !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key))
    throw new HttpError(400,'INVALID_REQUEST_ID','作成リクエストを確認してください。');
  const token = (await sha256('guest-room-session:'+key)).slice(0,43);
  const hash = await sha256(token), room = await sha256('guest-room-id:'+key);
  const existing = () => c.env.DB.prepare('SELECT 1 FROM guest_sessions WHERE token_hash=? AND room_id=? AND expires_at>?').bind(hash,room,Date.now()).first();
  if (!await existing()) {
    await enforceIpRate(c.env,c.req.raw,'guest-create-room',5,86400_000);
    try {
      await createGuestRoom(c.env,room,crypto.randomUUID(),'human',{name:input.name,display_name:input.display_name,description:input.description,tags:input.tags,image:input.image},hash,randomToken());
    } catch (e) { if (!await existing()) throw e; }
    c.executionCtx.waitUntil(roomDirectoryChanged(c.env,room));
  }
  c.header('Set-Cookie', `${GUEST_COOKIE}_${room}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${guestLifetime/1000}`);
  return c.json({room_id:room},201);
});

publicApi.all('/rooms/:id/mcp', async c => {
  const room = c.req.param('id');
  await anonymousRoom(c.env,room);
  return guestMcp(c.req.raw,c.env,c.executionCtx,room);
});

publicApi.get('/rooms/:id/inbox/:action', async c => {
  const room = c.req.param('id');
  const session = await guestSession(c.req.raw, c.env, room);
  if (!session) throw new HttpError(401, 'GUEST_REQUIRED', '匿名で参加してください。');
  if (c.req.param('action') === 'live') return subscribeInbox(c.env, c.req.raw, session);
  if (c.req.param('action') === 'latest') return c.json(await latestIncoming(c.env, session.user.id, c.req.query('after'), room));
  throw new HttpError(404, 'NOT_FOUND', 'ページが見つかりません。');
});

publicApi.put('/rooms/:id/reply-status', async c => {
  const room = c.req.param('id');
  requireOrigin(c.req.raw,c.env);
  const session = await guestSession(c.req.raw,c.env,room);
  if (!session) throw new HttpError(401,'GUEST_REQUIRED','匿名で参加してください。');
  requireCsrf(c.req.raw,session);
  const user = session.user;
  await enforceIpRate(c.env,c.req.raw,'typing',1200,3600_000);
  return c.json(await setHumanReplyStatus(c.env,room,user.id,(await c.req.json()).active));
});

publicApi.get('/rooms/:id/reply-status', async c => {
  const room = c.req.param('id');
  const { viewer } = await previewRoom(c.req.raw, c.env, room);
  await enforceIpRate(c.env, c.req.raw, 'reply-status', 2400, 3_600_000);
  c.header('Cache-Control', 'private, no-store');
  return c.json(await replyingParticipants(c.env, room, viewer));
});

publicApi.get('/rooms/:id/messages', async (c) => {
  const roomId = c.req.param('id');
  const { viewer } = await previewRoom(c.req.raw, c.env, roomId);
  await enforceIpRate(c.env, c.req.raw, 'public-messages', 600, 60 * 60_000);
  if (c.req.query('view') === 'timeline') return c.json(await roomTimelinePage(c.env, viewer, roomId, c.req.query('before')));
  return c.json(await roomMessagePage(c.env, viewer, roomId, c.req.query('since'), c.req.query('before')));
});

publicApi.get('/rooms/:id/profiles/:kind/:subject', async c => {
  const room = c.req.param('id');
  const { viewer } = await previewRoom(c.req.raw, c.env, room);
  return c.json(await roomProfile(c.env, room, viewer, c.req.param('kind'), c.req.param('subject'), true));
});

publicApi.post('/rooms/:id/read-receipts', async c => {
  requireOrigin(c.req.raw, c.env);
  const room = c.req.param('id');
  await anonymousRoom(c.env, room);
  const session = await guestSession(c.req.raw, c.env, room);
  if (!session) throw new HttpError(401, 'GUEST_REQUIRED', '匿名で参加してください。');
  requireCsrf(c.req.raw, session);
  await recordHumanReads(c.env, session.user.id, room, (await body(c.req.raw)).messages);
  return c.json({ ok: true });
});

publicApi.get('/rooms/:id/images', async (c) => {
  const roomId = c.req.param('id');
  const { viewer } = await previewRoom(c.req.raw, c.env, roomId);
  return c.json({ images: await publicRoomImages(c.env, roomId, viewer) });
});

publicApi.get('/rooms/:id/images/:kind/:subjectId', async (c) => {
  const roomId = c.req.param('id');
  const { viewer } = await previewRoom(c.req.raw, c.env, roomId);
  const image = await publicRoomImageData(c.env, roomId, imageKind(c.req.param('kind')), c.req.param('subjectId'), viewer);
  if (!image) throw new HttpError(404, 'IMAGE_NOT_FOUND', '画像が見つかりません。');
  return new Response(Uint8Array.from(image.image_data), { headers: { 'Content-Type': image.mime_type, 'Cache-Control': 'private, no-store' } });
});

publicApi.get('/rooms/:id/session', async (c) => {
  const roomId = c.req.param('id');
  const { guest: session } = await previewRoom(c.req.raw, c.env, roomId);
  return c.json(session ? { active: true, user_id: session.user.id, display_name: session.user.display_name || '匿名', csrf: session.csrf } : { active: false });
});

const activeGuestMembership = `FROM guest_sessions s JOIN rooms r ON r.id=s.room_id
  JOIN room_members m ON m.room_id=r.id AND m.user_id=s.user_id AND m.kind='human'
  WHERE s.token_hash=? AND s.user_id=? AND s.room_id=? AND s.expires_at>? AND r.visibility='public' AND r.access_mode='anonymous'`;

function updateGuestImage(env: Bindings, session: Session, room: string, image: ReturnType<typeof parseImage>, now: number) {
  return env.DB.prepare(`INSERT INTO profile_images (kind, subject_id, owner_id, mime_type, image_data, updated_at)
    SELECT 'user', s.user_id, s.user_id, ?, ?, ? ${activeGuestMembership}
    ON CONFLICT(kind,subject_id) DO UPDATE SET mime_type=excluded.mime_type,image_data=excluded.image_data,
    updated_at=MAX(profile_images.updated_at+1,excluded.updated_at) RETURNING updated_at`)
    .bind(image.mime,image.bytes.buffer,now,session.tokenHash,session.user.id,room,now);
}

async function editableGuest(request: Request, env: Bindings, room: string) {
  requireOrigin(request, env);
  const session = await guestSession(request, env, room);
  if (!session) throw new HttpError(401, 'GUEST_REQUIRED', '匿名で参加してください。');
  requireCsrf(request, session);
  await enforceIpRate(env, request, 'guest-image', 30, 3_600_000);
  return session;
}

publicApi.put('/rooms/:id/session/image', async c => {
  const room = c.req.param('id');
  const session = await editableGuest(c.req.raw, c.env, room);
  const row = await updateGuestImage(c.env, session, room, parseImage(await body(c.req.raw)), Date.now()).first();
  if (!row) throw new HttpError(401, 'GUEST_REQUIRED', '匿名で参加してください。');
  return c.json(row);
});

publicApi.patch('/rooms/:id/session/profile', async c => {
  const room = c.req.param('id');
  const session = await editableGuest(c.req.raw, c.env, room);
  const input = await body(c.req.raw), name = validateText(input.display_name,40,'表示名');
  const photo = optionalImage(input.image), now = Date.now();
  const [updated, image] = await c.env.DB.batch<{updated_at:number}>([
    c.env.DB.prepare(`UPDATE users SET display_name=? WHERE is_guest=1 AND id IN (SELECT s.user_id ${activeGuestMembership})`)
      .bind(name,session.tokenHash,session.user.id,room,now),
    ...(photo ? [updateGuestImage(c.env, session, room, photo, now)] : []),
  ]);
  if (!updated.meta.changes) throw new HttpError(401, 'GUEST_REQUIRED', '匿名で参加してください。');
  c.executionCtx.waitUntil(roomDirectoryChanged(c.env, room));
  return c.json({ display_name:name, image_version:image?.results[0]?.updated_at ?? null });
});

publicApi.post('/rooms/:id/session', async (c) => {
  requireOrigin(c.req.raw, c.env);
  const roomId = c.req.param('id'); await anonymousRoom(c.env, roomId);
  const existing = await guestSession(c.req.raw, c.env, roomId);
  if (existing) return c.json({ active: true, user_id: existing.user.id, display_name: existing.user.display_name || '匿名', csrf: existing.csrf });
  await enforceIpRate(c.env, c.req.raw, 'guest-session', 12, 60 * 60_000);
  const id = crypto.randomUUID(); const token = randomToken(); const csrf = randomToken(); const now = Date.now();
  const input = await body(c.req.raw, true);
  const name = input.display_name === undefined ? '匿名' : validateText(input.display_name, 40, '表示名');
  const photo = optionalImage(input.image);
  const identifier = crypto.randomUUID().replaceAll('-', '').slice(0, 20);
  const results = await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO users (id, account_name, email, display_name, created_at, is_guest)
      SELECT ?, ?, ?, ?, ?, 1 WHERE EXISTS (SELECT 1 FROM rooms WHERE id = ? AND visibility = 'public' AND access_mode = 'anonymous')`)
      .bind(id, `guest-${identifier}`, `guest-${identifier}@guest.invalid`, name, now, roomId),
    c.env.DB.prepare(`INSERT INTO room_members (id, room_id, user_id, kind, joined_at)
      SELECT ?, ?, ?, 'human', ? WHERE EXISTS (SELECT 1 FROM users WHERE id = ? AND is_guest = 1)
      AND EXISTS (SELECT 1 FROM rooms WHERE id = ? AND visibility = 'public' AND access_mode = 'anonymous')`)
      .bind(crypto.randomUUID(), roomId, id, now, id, roomId),
    c.env.DB.prepare(`INSERT INTO guest_sessions (token_hash, user_id, room_id, csrf_token, expires_at, created_at)
      SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ? AND kind = 'human')`)
      .bind(await sha256(token), id, roomId, csrf, now + GUEST_TTL, now, roomId, id),
    ...(photo ? [c.env.DB.prepare(`INSERT INTO profile_images (kind,subject_id,owner_id,mime_type,image_data,updated_at)
      SELECT 'user',user_id,user_id,?,?,? FROM guest_sessions WHERE user_id=? AND room_id=?`)
      .bind(photo.mime,photo.bytes.buffer,now,id,roomId)] : []),
  ]);
  if (!results[2].meta.changes) throw new HttpError(404, 'ROOM_NOT_FOUND', 'ルームが見つかりません。');
  c.executionCtx.waitUntil(roomDirectoryChanged(c.env, roomId));
  c.header('Set-Cookie', `${GUEST_COOKIE}_${roomId}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${GUEST_TTL / 1000}`);
  return c.json({ active: true, user_id: id, display_name: name, csrf, image_version: photo ? now : null }, 201);
});

publicApi.post('/rooms/:id/messages', async (c) => {
  requireOrigin(c.req.raw, c.env);
  const roomId = c.req.param('id'); await anonymousRoom(c.env, roomId);
  const session = await guestSession(c.req.raw, c.env, roomId);
  if (!session) throw new HttpError(401, 'GUEST_REQUIRED', '匿名で参加してください。');
  requireCsrf(c.req.raw, session);
  await enforceIpRate(c.env, c.req.raw, 'guest-post', 60, 60 * 60_000);
  const data = await body(c.req.raw); const replyTo = typeof data.reply_to === 'string' ? data.reply_to : null;
  const id = await postHumanMessage(c.env, session.user, roomId, data.body, replyTo);
  c.executionCtx.waitUntil(signalMessage(c.env, id));
  return c.json({ id }, 201);
});

publicApi.post('/rooms/:id/session/end', async (c) => {
  requireOrigin(c.req.raw, c.env);
  const roomId = c.req.param('id'); await anonymousRoom(c.env, roomId);
  const session = await guestSession(c.req.raw, c.env, roomId);
  if (!session) throw new HttpError(401, 'GUEST_REQUIRED', '匿名で参加してください。');
  requireCsrf(c.req.raw, session);
  const scoped = GUEST_COOKIE+'_'+roomId;
  const cookieName = parseCookies(c.req.header('Cookie') ?? null)[scoped] ? scoped : GUEST_COOKIE;
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM guest_sessions WHERE token_hash = ? AND user_id = ? AND room_id = ?').bind(session.tokenHash, session.user.id, roomId),
    c.env.DB.prepare("DELETE FROM room_members WHERE room_id = ? AND user_id = ? AND kind = 'human'").bind(roomId, session.user.id),
  ]);
  c.executionCtx.waitUntil(roomDirectoryChanged(c.env, roomId));
  c.header('Set-Cookie', `${cookieName}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
  return c.json({ ok: true });
});

publicApi.post('/rooms/:id/reports', async (c) => {
  requireOrigin(c.req.raw, c.env);
  const roomId = c.req.param('id'); await anonymousRoom(c.env, roomId);
  const session = await guestSession(c.req.raw, c.env, roomId);
  if (!session) throw new HttpError(401, 'GUEST_REQUIRED', '匿名で参加してください。');
  requireCsrf(c.req.raw, session);
  await enforceIpRate(c.env, c.req.raw, 'guest-report', 30, 60 * 60_000);
  const data = await body(c.req.raw); const messageId = typeof data.message_id === 'string' ? data.message_id : '';
  const reason = validateText(data.reason, 1000, '通報理由');
  const result = await c.env.DB.prepare(`INSERT INTO reports (id, message_id, reporter_user_id, reason, created_at)
    SELECT ?, m.id, ?, ?, ? FROM messages m JOIN rooms r ON r.id = m.room_id
    WHERE m.id = ? AND m.room_id = ? AND m.deleted_at IS NULL AND r.visibility = 'public' AND r.access_mode = 'anonymous'`)
    .bind(crypto.randomUUID(), session.user.id, reason, Date.now(), messageId, roomId).run();
  if (!result.meta.changes) throw new HttpError(404, 'MESSAGE_NOT_FOUND', 'メッセージが見つかりません。');
  return c.json({ ok: true }, 201);
});

publicApi.post('/rooms/:id/media-messages', async c => {
  const room = c.req.param('id');
  requireOrigin(c.req.raw,c.env);
  await anonymousRoom(c.env,room);
  const session = await guestSession(c.req.raw,c.env,room);
  if (!session) throw new HttpError(401,'GUEST_REQUIRED','ルームに参加してください。');
  requireCsrf(c.req.raw,session);
  const user = session.user;
  await enforceIpRate(c.env,c.req.raw,'chat-upload',60,3600_000);
  const upload = await prepareUpload(c.req.raw);
  const id = await postHumanMessage(c.env,user,room,upload.body,upload.reply,upload.media);
  c.executionCtx.waitUntil(signalMessage(c.env,id));
  return c.json({ id },201);
});
publicApi.put('/rooms/:id/messages/:message/reaction', async c => {
  const room = c.req.param('id');
  requireOrigin(c.req.raw,c.env);
  await anonymousRoom(c.env,room);
  const session = await guestSession(c.req.raw,c.env,room);
  if (!session) throw new HttpError(401,'GUEST_REQUIRED','ルームに参加してください。');
  requireCsrf(c.req.raw,session);
  const user = session.user;
  const data = await body(c.req.raw);
  return c.json({ reactions: await setReaction(c.env,user,room,c.req.param('message'),data.emoji) });
});
publicApi.get('/rooms/:id/attachments/:file', async c => {
  const room = c.req.param('id');
  const { viewer } = await previewRoom(c.req.raw, c.env, room);
  return serveAttachment(c.env,viewer,room,c.req.param('file'),c.req.raw,true);
});
