import { translateMessage } from './message-translation';
import { getVerification, updateVerification } from './verification';
import { pageSize } from '../shared/directory';
import { updateRoomSettings } from './room-access';
import { socialNames, socialServices, socialUrl, type SocialLinks } from '../shared/social-links';
import { configuredOwnerId } from './account-names';
import { replyingParticipants, setHumanReplyStatus } from './reply-status';
import { prepareUpload, serveAttachment, setReaction } from './chat-media';
import { changeWebhook, getWebhook } from './webhook-settings';
import { latestIncoming, subscribeInbox } from './message-inbox';
import { signalMessage } from './wakes';
import { Hono } from 'hono';
import { z } from 'zod';
import type { Agent, Bindings, OAuthProps, Session, User } from './types';
import { HttpError } from './types';
import { deleteSession, enforceIpRate, getSession, randomToken, requireCsrf, requireOrigin, sha256 } from './security';
import { validTime, validTimezone, validateAccountName, validateText } from './domain';
import { advanceCursor, getRoom, ownedAgent, postHumanMessage, requireHumanMember } from './store';
import { imageKind, parseImage, requireImageOwner, visibleImageData, visibleImages } from './images';
import { changeTags, parseTags, readTags, writeTags, directoryPage, roomMessageCount, popularRoomTags } from './directory';
import { agentDirectoryChanged, broadcastDirectory, roomDirectoryChanged, messageDirectoryChanged } from './directory-hub';
import { publicAccessEnabled } from './public-access';
import { roomProfile } from './room-profiles';
import { recordHumanReads, roomMessagePage, roomTimelinePage } from './messages';

type Context = { Bindings: Bindings; Variables: { session: Session; user: User } };
export const api = new Hono<Context>();

function listWindow(value: string | undefined, defaultLimit: number) {
  const offset = Number(value ?? 0);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new HttpError(400, 'INVALID_OFFSET', '取得位置を確認してください。');
  return [value === undefined ? defaultLimit : pageSize, offset];
}

async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const result = await request.json();
    if (!result || Array.isArray(result) || typeof result !== 'object') throw new HttpError(400, 'INVALID_BODY', '入力内容を確認してください。');
    return result as Record<string, unknown>;
  } catch (error) {
    if (error instanceof SyntaxError) throw new HttpError(400, 'INVALID_BODY', '入力内容を確認してください。');
    throw error;
  }
}

function failInput(error: unknown): never {
  if (error instanceof z.ZodError) throw new HttpError(400, 'INVALID_INPUT', '入力内容を確認してください。');
  throw error;
}

api.use('*', async (c, next) => {
  if (['/api/setup','/api/login','/api/register'].includes(c.req.path)) throw new HttpError(404,'NOT_FOUND','ページが見つかりません。');
  if (c.req.path === '/api/session' && c.req.method === 'GET') return next();
  const session = await getSession(c.req.raw, c.env);
  if (!session) {
    const bearer = c.req.header('Authorization')?.match(/^Bearer (\S+)$/i)?.[1];
    if (bearer?.startsWith('a2a_')) {
      const validAgent = await c.env.DB.prepare(`SELECT c.id FROM agent_connections c JOIN agents a ON a.id = c.agent_id
        JOIN users u ON u.id = a.owner_id WHERE c.token_hash = ? AND c.revoked_at IS NULL AND a.deleted_at IS NULL
        AND (? <> 'true' OR u.id=${configuredOwnerId})`)
        .bind(await sha256(bearer), c.env.PRIVATE_BETA, c.env.OWNER_ACCOUNT).first();
      if (validAgent) throw new HttpError(403, 'HUMAN_SESSION_REQUIRED', 'この操作にはオーナーのログインが必要です。');
    } else if (bearer && c.env.OAUTH_PROVIDER) {
      const token = await c.env.OAUTH_PROVIDER.unwrapToken<OAuthProps>(bearer);
      const props = token?.grant.props;
      const audience = token?.audience;
      const matchesResource = Array.isArray(audience) ? audience.includes(`${c.env.PUBLIC_ORIGIN}/mcp`) : audience === `${c.env.PUBLIC_ORIGIN}/mcp`;
      if (token && token.expiresAt > Math.floor(Date.now() / 1000) && matchesResource && token.scope.includes('rooms') && props?.authKind === 'oauth') {
        const connection = await c.env.DB.prepare(`SELECT c.id FROM agent_connections c JOIN agents a ON a.id = c.agent_id
          JOIN users u ON u.id = a.owner_id WHERE c.id = ? AND a.id = ? AND a.owner_id = ? AND c.revoked_at IS NULL
          AND a.deleted_at IS NULL AND (? <> 'true' OR u.id=${configuredOwnerId})`)
          .bind(props.connectionId, props.agentId, props.userId, c.env.PRIVATE_BETA, c.env.OWNER_ACCOUNT).first();
        if (connection) throw new HttpError(403, 'HUMAN_SESSION_REQUIRED', 'この操作にはオーナーのログインが必要です。');
      }
    }
    throw new HttpError(401, 'AUTH_REQUIRED', 'ログインが必要です。');
  }
  c.set('session', session);
  c.set('user', session.user);
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    requireOrigin(c.req.raw, c.env);
    requireCsrf(c.req.raw, session);
  }
  return next();
});

api.get('/rooms/:id/messages/:message/note', async c =>
  c.json(await getVerification(c.env,c.req.param('id'),c.req.param('message'),{user:c.get('user').id})));
api.put('/rooms/:id/messages/:message/note', async c => {
  await enforceIpRate(c.env,c.req.raw,'verification-write',120,3600_000);
  return c.json(await updateVerification(c.env,c.req.param('id'),c.req.param('message'),{user:c.get('user').id},await jsonBody(c.req.raw)));
});

api.get('/session', async (c) => {
  const session = await getSession(c.req.raw, c.env);
  if (!session) return c.json({ authenticated: false, needsSetup: false, publicAccess: publicAccessEnabled(c.env) });
  return c.json({ authenticated: true, user: session.user, csrf: session.csrf, privateBeta: c.env.PRIVATE_BETA === 'true', publicAccess: publicAccessEnabled(c.env), operator: session.operator });
});

api.patch('/account/id', c => c.json({ error: 'ACCOUNT_ID_FIXED', message: 'アカウントIDは登録後に変更できません。' }, 403));

api.get('/account/profile/social-links', async c => {
  const stored = await c.env.DB.prepare('SELECT social_links FROM users WHERE id=?').bind(c.get('user').id).first<string>('social_links');
  return c.json(JSON.parse(stored ?? '{}'));
});

api.put('/account/profile/social-links', async c => {
  const input = await jsonBody(c.req.raw);
  if (Object.keys(input).some(key => !Object.hasOwn(socialNames,key))) throw new HttpError(400,'UNKNOWN_SERVICE','SNSを確認してください。');
  const links: SocialLinks = {};
  for (const service of socialServices) {
    const value = input[service];
    if (value === undefined || value === '') continue;
    const url = typeof value === 'string' && socialUrl(service,value);
    if (!url) throw new HttpError(400,'INVALID_SOCIAL_URL',socialNames[service]+' URL');
    links[service] = url;
  }
  await c.env.DB.prepare('UPDATE users SET social_links=? WHERE id=?').bind(JSON.stringify(links),c.get('user').id).run();
  return c.json(links);
});

api.put('/account/profile/bio', async c => {
  const body = await jsonBody(c.req.raw);
  const input = body.bio;
  if (body.bio_public !== undefined && typeof body.bio_public !== 'boolean') throw new HttpError(400,'INVALID_BIO','公開設定を確認してください。');
  if (typeof input !== 'string') throw new HttpError(400,'INVALID_BIO','自己紹介を確認してください。');
  const bio = validateText(input, 300, '自己紹介', 0);
  const row = await c.env.DB.prepare("UPDATE users SET bio=NULLIF(?,''), bio_public=COALESCE(?,bio_public) WHERE id=? RETURNING bio_public")
    .bind(bio,body.bio_public === undefined ? null : Number(body.bio_public),c.get('user').id).first<{bio_public:number}>();
  return c.json({bio,bio_public:Boolean(row?.bio_public)});
});

api.patch('/account/profile', async c => {
  const name = validateText((await jsonBody(c.req.raw)).display_name, 40, '表示名');
  await c.env.DB.prepare('UPDATE users SET display_name=NULLIF(?,account_name COLLATE BINARY) WHERE id=?').bind(name, c.get('user').id).run();
  return c.json({ display_name: name });
});

api.post('/logout', async (c) => {
  c.header('Set-Cookie', await deleteSession(c.req.raw, c.env));
  return c.json({ ok: true });
});

api.get('/account/avatar', async c => {
  const userId = c.get('user').id;
  const image = await visibleImageData(c.env, userId, 'user', userId);
  if (!image) return c.body(null, 204);
  return c.body(Uint8Array.from(image.image_data), 200, { 'Content-Type': image.mime_type });
});

api.get('/images', async (c) => c.json({ images: await visibleImages(c.env, c.get('user').id) }));

api.get('/images/:kind/:id', async (c) => {
  const image = await visibleImageData(c.env, c.get('user').id, imageKind(c.req.param('kind')), c.req.param('id'));
  if (!image) throw new HttpError(404, 'IMAGE_NOT_FOUND', '画像が見つかりません。');
  return c.body(Uint8Array.from(image.image_data), 200, { 'Content-Type': image.mime_type, 'Cache-Control': 'private, no-store' });
});

api.put('/images/:kind/:id', async (c) => {
  const user = c.get('user'); const kind = imageKind(c.req.param('kind')); const subjectId = c.req.param('id');
  await requireImageOwner(c.env, user, kind, subjectId);
  await enforceIpRate(c.env, c.req.raw, 'image-upload', 100, 60 * 60_000);
  const image = parseImage(await jsonBody(c.req.raw));
  await c.env.DB.prepare(`INSERT INTO profile_images (kind, subject_id, owner_id, mime_type, image_data, updated_at)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(kind, subject_id) DO UPDATE SET mime_type = excluded.mime_type,
    image_data = excluded.image_data, updated_at = MAX(profile_images.updated_at + 1, excluded.updated_at)
    WHERE profile_images.owner_id = excluded.owner_id`)
    .bind(kind, subjectId, user.id, image.mime, image.bytes.buffer, Date.now()).run();
  return c.json({ ok: true });
});

api.delete('/images/:kind/:id', async (c) => {
  const user = c.get('user'); const kind = imageKind(c.req.param('kind')); const subjectId = c.req.param('id');
  await requireImageOwner(c.env, user, kind, subjectId);
  await c.env.DB.prepare('DELETE FROM profile_images WHERE kind = ? AND subject_id = ? AND owner_id = ?').bind(kind, subjectId, user.id).run();
  return c.json({ ok: true });
});

api.get('/agents', async (c) => {
  const agents = await c.env.DB.prepare(`SELECT id, owner_id, name, handle, platform, mode, daily_limit, quiet_start, quiet_end,
    timezone, profile_text, autonomous_rooms, private_categories, tone_note, created_at, policy_revision FROM agents
    WHERE owner_id = ? AND deleted_at IS NULL ORDER BY created_at`).bind(c.get('user').id).all<Agent>();
  const connections = await c.env.DB.prepare(`SELECT c.id, c.agent_id, c.label, c.kind, c.created_at, c.revoked_at
    FROM agent_connections c JOIN agents a ON a.id = c.agent_id WHERE a.owner_id = ? AND a.deleted_at IS NULL ORDER BY c.created_at DESC`)
    .bind(c.get('user').id).all();
  return c.json({ agents: agents.results.map((a) => ({ ...a, private_categories: JSON.parse(a.private_categories) })), connections: connections.results });
});

api.post('/agents', async (c) => {
  const body = await jsonBody(c.req.raw);
  const name = validateText(body.name, 40, 'エージェント名');
  const platform = validateText(body.platform, 40, '接続環境');
  const id = crypto.randomUUID();
  const handle = typeof body.handle === 'string' && body.handle ? body.handle.trim().toLowerCase() : `agent-${id.slice(0, 8)}`;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(handle) || handle.length < 2 || handle.length > 32) throw new HttpError(400, 'INVALID_HANDLE', '識別名は2〜32文字の英数字とハイフンで入力してください。');
  const duplicate = await c.env.DB.prepare('SELECT id FROM agents WHERE owner_id = ? AND handle = ? AND deleted_at IS NULL').bind(c.get('user').id, handle).first();
  if (duplicate) throw new HttpError(409, 'DUPLICATE_HANDLE', 'この識別名はすでに使用されています。');
  await c.env.DB.prepare('INSERT INTO agents (id, owner_id, name, handle, platform, created_at, autonomous_rooms) VALUES (?, ?, ?, ?, ?, ?, 1)')
    .bind(id, c.get('user').id, name, handle, platform, Date.now()).run();
  return c.json({ id }, 201);
});

api.patch('/agents/:id', async (c) => {
  const current = await ownedAgent(c.env, c.get('user').id, c.req.param('id'));
  const input = await jsonBody(c.req.raw);
  const schema = z.object({
    autonomous_rooms: z.boolean().optional(),
    name: z.string().trim().min(1).max(40).optional(),
    platform: z.string().trim().min(1).max(40).optional(),
    mode: z.enum(['selective', 'all', 'mention_only', 'digest']).optional(),
    daily_limit: z.number().int().min(0).max(200).optional(),
    quiet_start: z.string().nullable().optional(), quiet_end: z.string().nullable().optional(),
    timezone: z.string().max(80).optional(), profile_text: z.string().max(2000).optional(),
    private_categories: z.array(z.string().min(1).max(100)).max(30).optional(), tone_note: z.string().max(1000).optional(),
  }).strict();
  let data: z.infer<typeof schema>;
  try { data = schema.parse(input); } catch (error) { failInput(error); }
  const start = data.quiet_start === undefined ? current.quiet_start : data.quiet_start;
  const end = data.quiet_end === undefined ? current.quiet_end : data.quiet_end;
  const timezone = data.timezone ?? current.timezone;
  if ((start === null) !== (end === null) || (start !== null && (!validTime(start) || !end || !validTime(end) || start === end)) || !validTimezone(timezone)) {
    throw new HttpError(400, 'INVALID_TIME', '静かな時間帯とタイムゾーンを確認してください。');
  }
  const updated = await c.env.DB.prepare(`UPDATE agents SET name = ?, platform = ?, mode = ?, daily_limit = ?, quiet_start = ?, quiet_end = ?,
    timezone = ?, profile_text = ?, private_categories = ?, tone_note = ?, autonomous_rooms = ?, policy_revision = policy_revision + 1 WHERE id = ? AND owner_id = ? AND policy_revision = ?`)
    .bind(data.name ?? current.name, data.platform ?? current.platform, data.mode ?? current.mode, data.daily_limit ?? current.daily_limit,
      start, end, timezone, data.profile_text ?? current.profile_text,
      data.private_categories ? JSON.stringify(data.private_categories) : current.private_categories,
      data.tone_note ?? current.tone_note, Number(data.autonomous_rooms ?? current.autonomous_rooms), current.id, current.owner_id, current.policy_revision).run();
  if (!updated.meta.changes) throw new HttpError(409, 'AGENT_CHANGED', '別の変更がありました。再度保存してください。');
  if (data.name && data.name !== current.name) c.executionCtx.waitUntil(agentDirectoryChanged(c.env,current.id));
  return c.json({ ok: true });
});

api.delete('/agents/:id', async c => {
  const agent = await ownedAgent(c.env, c.get('user').id, c.req.param('id'));
  const db = c.env.DB;
  const now = Date.now();
  await db.batch([
    db.prepare('UPDATE agents SET deleted_at=? WHERE id=? AND deleted_at IS NULL').bind(now, agent.id),
    db.prepare('UPDATE agent_connections SET revoked_at=? WHERE agent_id=? AND revoked_at IS NULL').bind(now, agent.id),
    db.prepare('DELETE FROM room_members WHERE agent_id=?').bind(agent.id),
    db.prepare('DELETE FROM agent_webhooks WHERE agent_id=?').bind(agent.id),
    db.prepare("DELETE FROM profile_images WHERE subject_id=? AND kind IN ('agent','platform')").bind(agent.id),
  ]);
  c.executionCtx.waitUntil(broadcastDirectory(c.env));
  return c.json({ ok: true });
});

api.post('/agents/:id/connections', async (c) => {
  const agent = await ownedAgent(c.env, c.get('user').id, c.req.param('id'));
  const body = await jsonBody(c.req.raw);
  const label = validateText(body.label ?? agent.platform, 80, '接続名');
  const token = `a2a_${randomToken()}`;
  const id = crypto.randomUUID();
  const result = await c.env.DB.prepare('INSERT INTO agent_connections (id, agent_id, label, kind, token_hash, created_at) SELECT ?, id, ?, ?, ?, ? FROM agents WHERE id=? AND deleted_at IS NULL')
    .bind(id, label, 'token', await sha256(token), Date.now(), agent.id).run();
  if (!result.meta.changes) throw new HttpError(404, 'AGENT_NOT_FOUND', 'エージェントが見つかりません。');
  return c.json({ id, token }, 201);
});

api.delete('/connections/:id', async (c) => {
  const result = await c.env.DB.prepare(`UPDATE agent_connections SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL
    AND agent_id IN (SELECT id FROM agents WHERE owner_id = ?)`)
    .bind(Date.now(), c.req.param('id'), c.get('user').id).run();
  if (!result.meta.changes) throw new HttpError(404, 'CONNECTION_NOT_FOUND', '接続が見つかりません。');
  return c.json({ ok: true });
});

api.get('/rooms', async (c) => {
  const user = c.get('user');
  const search = (c.req.query('q') ?? '').normalize('NFKC').trim().toLocaleLowerCase('ja');
  let matches: string | null = null;
  if (search) {
    const names = await c.env.DB.prepare(`SELECT r.id,r.name FROM rooms r JOIN room_members m ON m.room_id=r.id
      WHERE m.user_id=? AND m.kind='human'`).bind(user.id).all<{id:string;name:string}>();
    matches = JSON.stringify(names.results.filter(room => room.name.normalize('NFKC').toLocaleLowerCase('ja').includes(search)).map(room => room.id));
  }
  const result = await c.env.DB.prepare(`WITH counts AS (
    SELECT m.room_id, SUM(m.kind='human') AS human_count, SUM(m.kind='agent') AS agent_count
    FROM room_members own JOIN room_members m ON m.room_id=own.room_id JOIN users person ON person.id=m.user_id
    WHERE own.kind='human' AND own.user_id=?1
      AND (person.is_guest=0 OR EXISTS (SELECT 1 FROM guest_sessions g WHERE g.room_id=m.room_id AND g.user_id=m.user_id AND g.expires_at>?2))
      AND (m.kind='human' OR EXISTS (SELECT 1 FROM agents a WHERE a.id=m.agent_id AND a.deleted_at IS NULL))
    GROUP BY m.room_id
  ) SELECT counts.human_count, counts.agent_count, ${roomMessageCount('r.id','?1')} AS message_count, r.id, r.name, r.description, r.visibility, r.access_mode, r.created_at, CASE WHEN u.is_guest=1 THEN '匿名' ELSE u.account_name END AS host_account,
    (SELECT json_group_array(json_object('kind', portrait.kind, 'id', portrait.subject_id, 'name', portrait.name, 'image_version', portrait.image_version))
      FROM (SELECT member.kind, photo.updated_at AS image_version, COALESCE(member.agent_id, member.user_id) AS subject_id, COALESCE(agent.name, person.account_name) AS name
        FROM room_members member JOIN users person ON person.id = member.user_id
        LEFT JOIN agents agent ON agent.id = member.agent_id
        LEFT JOIN profile_images photo ON photo.subject_id = COALESCE(member.agent_id, member.user_id)
          AND photo.kind = CASE member.kind WHEN 'agent' THEN 'agent' ELSE 'user' END
        WHERE member.room_id = r.id AND person.is_guest = 0 AND NOT EXISTS
          (SELECT 1 FROM blocks b WHERE (b.user_id = ?1 AND b.blocked_user_id = member.user_id) OR (b.blocked_user_id = ?1 AND b.user_id = member.user_id))
        ORDER BY (member.kind = 'human' AND member.user_id = ?1), (photo.subject_id IS NULL), member.joined_at, member.id LIMIT 2
      ) portrait) AS portraits,
    (SELECT m.body FROM messages m WHERE m.room_id = r.id AND m.deleted_at IS NULL AND NOT EXISTS
      (SELECT 1 FROM blocks b WHERE (b.user_id = ?1 AND b.blocked_user_id = m.author_user_id) OR (b.blocked_user_id = ?1 AND b.user_id = m.author_user_id))
      ORDER BY m.seq DESC LIMIT 1) AS last_body,
    (SELECT m.created_at FROM messages m WHERE m.room_id = r.id AND m.deleted_at IS NULL AND NOT EXISTS
      (SELECT 1 FROM blocks b WHERE (b.user_id = ?1 AND b.blocked_user_id = m.author_user_id) OR (b.blocked_user_id = ?1 AND b.user_id = m.author_user_id))
      ORDER BY m.seq DESC LIMIT 1) AS last_message_at,
    (SELECT COUNT(*) FROM messages m WHERE m.room_id = r.id AND m.deleted_at IS NULL
      AND NOT (m.author_user_id = ?1 AND m.author_agent_id IS NULL)
      AND m.seq > COALESCE((SELECT last_seq FROM read_cursors WHERE room_id = r.id AND kind = 'human' AND subject_id = ?1), 0)
      AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.user_id = ?1 AND b.blocked_user_id = m.author_user_id) OR (b.blocked_user_id = ?1 AND b.user_id = m.author_user_id))) AS unread_count
    FROM rooms r JOIN users u ON u.id = r.host_user_id JOIN room_members rm ON rm.room_id = r.id
    JOIN counts ON counts.room_id=r.id
    WHERE rm.user_id = ?1 AND rm.kind = 'human' AND (?3 IS NULL OR r.id IN (SELECT value FROM json_each(?3)))
    ORDER BY COALESCE(last_message_at, r.created_at) DESC, r.id LIMIT ?4 OFFSET ?5`)
    .bind(user.id, Date.now(), matches, ...listWindow(c.req.query('offset'), -1)).all<{ portraits: string }>();
  return c.json({ rooms: result.results.map((row) => ({ ...row, portraits: JSON.parse(row.portraits) })) });
});

function listingChoice(mode: string, value: unknown, previous: boolean) {
  if (value !== undefined && typeof value !== 'boolean') throw new HttpError(400, 'INVALID_LISTING', '掲載設定を確認してください。');
  return mode !== 'invite' && (value === undefined ? previous : value);
}

api.post('/rooms', async (c) => {
  const body = await jsonBody(c.req.raw);
  const name = validateText(body.name, 80, 'ルーム名');
  const description = validateText(body.description ?? '', 500, '説明', 0);
  const accessMode = body.access_mode ?? (body.visibility === 'public' ? 'registered' : 'invite');
  if (accessMode !== 'invite' && accessMode !== 'registered' && accessMode !== 'anonymous') throw new HttpError(400, 'INVALID_ACCESS_MODE', '公開範囲を確認してください。');
  const visibility = accessMode === 'invite' ? 'invite' : 'public';
  const tags = parseTags(body.tags ?? []);
  const listed = listingChoice(accessMode, body.directory_listed, publicAccessEnabled(c.env));
  const id = crypto.randomUUID();
  const user = c.get('user');
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO rooms (id, host_user_id, name, description, visibility, access_mode, created_at, directory_listed) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, user.id, name, description, visibility, accessMode, now, Number(listed)),
    c.env.DB.prepare("INSERT INTO room_members (id, room_id, user_id, kind, joined_at) VALUES (?, ?, ?, 'human', ?)")
      .bind(crypto.randomUUID(), id, user.id, now),
    ...writeTags(c.env, id, tags),
  ]);
  if (listed) c.executionCtx.waitUntil(broadcastDirectory(c.env));
  return c.json({ id, host_account: user.account_name }, 201);
});

api.get('/rooms/:id', async (c) => {
  const room = await requireHumanMember(c.env, c.get('user'), c.req.param('id'));
  const members = await c.env.DB.prepare(`SELECT rm.id, rm.kind, rm.user_id, rm.agent_id, u.is_guest,
    (SELECT h.handle FROM guest_agent_handles h WHERE h.agent_id=rm.agent_id) AS guest_handle, CASE WHEN u.is_guest = 1 THEN '匿名' ELSE u.account_name END AS account_name,
    u.display_name AS display_name, a.name AS agent_name, a.handle, a.platform, rm.joined_at FROM room_members rm JOIN users u ON u.id = rm.user_id
    LEFT JOIN agents a ON a.id = rm.agent_id WHERE rm.room_id = ? AND (u.is_guest = 0 OR EXISTS
      (SELECT 1 FROM guest_sessions gs WHERE gs.user_id = u.id AND gs.room_id = rm.room_id AND gs.expires_at > ?)) ORDER BY rm.joined_at`)
    .bind(room.id, Date.now()).all();
  const tags = await readTags(c.env, room.id).all<{label:string}>();
  return c.json({ room: {...room, tags: tags.results.map(t=>t.label)}, members: members.results });
});

api.patch('/rooms/:id/name', async c => {
  const user = c.get('user');
  const room = await requireHumanMember(c.env, user, c.req.param('id'));
  if (room.host_user_id !== user.id) throw new HttpError(403, 'HOST_REQUIRED', 'ルーム名は主催者のみ変更できます。');
  const body = await jsonBody(c.req.raw);
  const name = validateText(body.name, 80, 'ルーム名');
  const result = await c.env.DB.prepare('UPDATE rooms SET name=? WHERE id=? AND host_user_id=?').bind(name, room.id, user.id).run();
  if (!result.meta.changes) throw new HttpError(404, 'ROOM_NOT_FOUND', 'ルームが見つかりません。');
  if (room.directory_listed) c.executionCtx.waitUntil(broadcastDirectory(c.env));
  return c.json({ name });
});

api.patch('/rooms/:id/description', async c => {
  const user = c.get('user');
  const room = await requireHumanMember(c.env, user, c.req.param('id'));
  if (room.host_user_id !== user.id) throw new HttpError(403, 'HOST_REQUIRED', '説明は主催者のみ変更できます。');
  const body = await jsonBody(c.req.raw);
  if (typeof body.description !== 'string') throw new HttpError(400, 'INVALID_TEXT', '説明は文字列で指定してください。');
  const description = validateText(body.description, 500, '説明', 0);
  const result = await c.env.DB.prepare('UPDATE rooms SET description=? WHERE id=? AND host_user_id=?')
    .bind(description, room.id, user.id).run();
  if (!result.meta.changes) throw new HttpError(404, 'ROOM_NOT_FOUND', 'ルームが見つかりません。');
  if (room.directory_listed) c.executionCtx.waitUntil(broadcastDirectory(c.env));
  return c.json({ description });
});

api.patch('/rooms/:id/tags', async c => {
  const user = c.get('user');
  const room = await requireHumanMember(c.env, user, c.req.param('id'));
  if (room.host_user_id !== user.id) throw new HttpError(403, 'HOST_REQUIRED', 'タグは主催者のみ変更できます。');
  const body = await jsonBody(c.req.raw);
  const tags = await changeTags(c.env, room.id, body.operation, body.tags);
  if (room.directory_listed) c.executionCtx.waitUntil(broadcastDirectory(c.env));
  return c.json({ tags });
});

api.patch('/rooms/:id/access', async (c) => {
  const user = c.get('user'); const room = await requireHumanMember(c.env, user, c.req.param('id'));
  if (room.host_user_id !== user.id) throw new HttpError(403, 'HOST_REQUIRED', '公開範囲は主催者のみ変更できます。');
  const body = await jsonBody(c.req.raw); const mode = body.access_mode;
  if (mode !== 'invite' && mode !== 'registered' && mode !== 'anonymous') throw new HttpError(400, 'INVALID_ACCESS_MODE', '公開範囲を確認してください。');
  const listed = listingChoice(mode, body.directory_listed, room.directory_listed === 1 || (room.access_mode === 'invite' && publicAccessEnabled(c.env)));
  await updateRoomSettings(c.env, c.executionCtx, room, {access_mode:mode, tags:body.tags}, {listed});
  return c.json({ ok: true });
});

api.get('/directory/popular-tags', async c => {
  return c.json({ tags: await popularRoomTags(c.env, c.get('user').id) });
});

api.get('/directory/rooms', async (c) => {
  return c.json(await directoryPage(c.env, new URL(c.req.url), c.get('user').id, null, true));
});

api.get('/directory/rooms/:id', async (c) => {
  if (!publicAccessEnabled(c.env)) throw new HttpError(404, 'ROOM_NOT_FOUND', 'ルームが見つかりません。');
  const user = c.get('user');
  const room = await c.env.DB.prepare(`SELECT r.id, r.name, r.description, r.access_mode, r.directory_listed, CASE WHEN u.is_guest=1 THEN '匿名' ELSE u.account_name END AS host_account
    FROM rooms r JOIN users u ON u.id = r.host_user_id WHERE r.id = ? AND (r.host_user_id=?2 OR (r.visibility = 'public' AND r.access_mode IN ('registered', 'anonymous')))
    AND NOT EXISTS (SELECT 1 FROM room_expulsions x WHERE x.room_id=r.id AND x.user_id=?2)
    AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.user_id = ?2 AND b.blocked_user_id = r.host_user_id)
      OR (b.blocked_user_id = ? AND b.user_id = r.host_user_id))`)
    .bind(c.req.param('id'), user.id, user.id).first();
  if (!room) throw new HttpError(404, 'ROOM_NOT_FOUND', 'ルームが見つかりません。');
  return c.json({ room });
});

api.post('/rooms/:id/agents', async (c) => {
  const user = c.get('user');
  const room = await requireHumanMember(c.env, user, c.req.param('id'));
  const input = await jsonBody(c.req.raw);
  const agentId = typeof input.agent_id === 'string' ? input.agent_id : '';
  const agent = await ownedAgent(c.env, user.id, agentId);
  const result = await c.env.DB.prepare("INSERT OR IGNORE INTO room_members (id, room_id, user_id, agent_id, kind, joined_at) SELECT ?, ?, ?, id, 'agent', ? FROM agents WHERE id=? AND deleted_at IS NULL")
    .bind(crypto.randomUUID(), room.id, user.id, Date.now(), agent.id).run();
  if (!result.meta.changes) throw new HttpError(409, 'ALREADY_A_MEMBER', 'このエージェントはすでに参加しています。');
  c.executionCtx.waitUntil(roomDirectoryChanged(c.env,room.id));
  return c.json({ ok: true }, 201);
});

api.delete('/rooms/:id/agents/:agentId', async (c) => {
  const user = c.get('user');
  await ownedAgent(c.env, user.id, c.req.param('agentId'));
  const result = await c.env.DB.prepare("DELETE FROM room_members WHERE room_id = ? AND agent_id = ? AND user_id = ? AND kind = 'agent'")
    .bind(c.req.param('id'), c.req.param('agentId'), user.id).run();
  if (!result.meta.changes) throw new HttpError(404, 'MEMBERSHIP_NOT_FOUND', '参加情報が見つかりません。');
  c.executionCtx.waitUntil(roomDirectoryChanged(c.env,c.req.param('id')));
  return c.json({ ok: true });
});

api.delete('/rooms/:id/members/:memberId', async (c) => {
  const user = c.get('user');
  const room = await requireHumanMember(c.env, user, c.req.param('id'));
  if (room.host_user_id !== user.id) throw new HttpError(403, 'HOST_REQUIRED', '参加者は主催者のみ退室させられます。');
  const member = await c.env.DB.prepare('SELECT id, user_id, kind FROM room_members WHERE id = ? AND room_id = ?')
    .bind(c.req.param('memberId'), room.id).first<{ id: string; user_id: string; kind: string }>();
  if (!member) throw new HttpError(404, 'MEMBERSHIP_NOT_FOUND', '参加情報が見つかりません。');
  if (member.kind === 'human' && member.user_id === room.host_user_id) throw new HttpError(400, 'HOST_CANNOT_LEAVE', '主催者はこの操作では退室できません。');
  if (member.kind === 'human') {
    await c.env.DB.prepare(`INSERT OR IGNORE INTO room_expulsions(room_id,user_id)
      SELECT room_id,user_id FROM room_members WHERE id=? AND room_id=? AND kind='human'`)
      .bind(member.id, room.id).run();
  } else {
    await c.env.DB.prepare('DELETE FROM room_members WHERE id=? AND room_id=?').bind(member.id, room.id).run();
  }
  c.executionCtx.waitUntil(roomDirectoryChanged(c.env,room.id));
  return c.json({ ok: true });
});

api.put('/rooms/:id/reply-status', async c => {
  const room = c.req.param('id');
  const user = c.get('user');
  await enforceIpRate(c.env,c.req.raw,'typing',1200,3600_000);
  return c.json(await setHumanReplyStatus(c.env,room,user.id,(await c.req.json()).active));
});

api.get('/rooms/:id/reply-status', async c => {
  const room = c.req.param('id');
  const user = c.get('user');
  await requireHumanMember(c.env, user, room);
  const viewer = user.id;
  c.header('Cache-Control', 'private, no-store');
  return c.json(await replyingParticipants(c.env, room, viewer));
});

api.post('/rooms/:id/messages/:message/translation', async c => {
  const viewer = { id: c.get('user').id, preview: false };
  c.header('Cache-Control', 'private, no-store');
  return c.json(await translateMessage(c.env, c.req.raw, c.req.param('id'), c.req.param('message'), viewer));
});

api.get('/rooms/:id/messages', async (c) => {
  const user = c.get('user');
  const room = await requireHumanMember(c.env, user, c.req.param('id'));
  if (c.req.query('view') === 'timeline') return c.json(await roomTimelinePage(c.env, user.id, room.id, c.req.query('before')));
  return c.json(await roomMessagePage(c.env, user.id, room.id, c.req.query('since'), c.req.query('before')));
});

api.post('/rooms/:id/messages', async (c) => {
  const body = await jsonBody(c.req.raw);
  const replyTo = typeof body.reply_to === 'string' ? body.reply_to : null;
  const id = await postHumanMessage(c.env, c.get('user'), c.req.param('id'), body.body, replyTo);
  c.executionCtx.waitUntil(signalMessage(c.env, id));
  return c.json({ id }, 201);
});

api.get('/rooms/:id/profiles/:kind/:subject', async c => {
  return c.json(await roomProfile(c.env, c.req.param('id'), c.get('user').id, c.req.param('kind'), c.req.param('subject')));
});

api.post('/rooms/:id/read-receipts', async c => {
  const user = c.get('user');
  const room = await requireHumanMember(c.env, user, c.req.param('id'));
  const repliesRead = await recordHumanReads(c.env, user.id, room.id, (await jsonBody(c.req.raw)).messages, true);
  return c.json({ ok: true, replies_read: repliesRead });
});

api.post('/rooms/:id/read', async (c) => {
  const user = c.get('user');
  const room = await requireHumanMember(c.env, user, c.req.param('id'));
  const body = await jsonBody(c.req.raw);
  const id = typeof body.message_id === 'string' ? body.message_id : '';
  const message = await c.env.DB.prepare('SELECT seq FROM messages WHERE id = ? AND room_id = ?').bind(id, room.id).first<{ seq: number }>();
  if (!message) throw new HttpError(400, 'INVALID_CURSOR', '既読位置が不正です。');
  await advanceCursor(c.env, room.id, 'human', user.id, message.seq);
  return c.json({ ok: true });
});

api.patch('/messages/:id', async (c) => {
  const user = c.get('user');
  const body = await jsonBody(c.req.raw);
  const text = validateText(body.body, 4000, 'メッセージ');
  const [result] = await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE messages SET body = ?, media_label_only = 0, edited_at = MAX(COALESCE(edited_at, 0) + 1, ?)
      WHERE id = ? AND author_user_id = ? AND deleted_at IS NULL AND NOT EXISTS
        (SELECT 1 FROM room_expulsions x WHERE x.room_id=messages.room_id AND x.user_id=messages.author_user_id)`)
      .bind(text, Date.now(), c.req.param('id'), user.id),
    c.env.DB.prepare(`DELETE FROM agent_message_reads WHERE message_id = ? AND EXISTS
      (SELECT 1 FROM messages WHERE id = ? AND author_user_id = ? AND deleted_at IS NULL AND NOT EXISTS
        (SELECT 1 FROM room_expulsions x WHERE x.room_id=messages.room_id AND x.user_id=messages.author_user_id))`)
      .bind(c.req.param('id'), c.req.param('id'), user.id),
  ]);
  if (!result.meta.changes) throw new HttpError(404, 'MESSAGE_NOT_FOUND', 'メッセージが見つかりません。');
  return c.json({ ok: true });
});

api.delete('/messages/:id', async (c) => {
  const result = await c.env.DB.prepare('UPDATE messages SET deleted_at = ? WHERE id = ? AND author_user_id = ? AND deleted_at IS NULL')
    .bind(Date.now(), c.req.param('id'), c.get('user').id).run();
  if (!result.meta.changes) throw new HttpError(404, 'MESSAGE_NOT_FOUND', 'メッセージが見つかりません。');
  c.executionCtx.waitUntil(messageDirectoryChanged(c.env,c.req.param('id')));
  return c.json({ ok: true });
});

api.post('/rooms/:id/invites', async (c) => {
  const user = c.get('user');
  const room = await requireHumanMember(c.env, user, c.req.param('id'));
  if (room.host_user_id !== user.id) throw new HttpError(403, 'HOST_REQUIRED', '招待リンクは主催者のみ発行できます。');
  const code = randomToken();
  const now = Date.now();
  await c.env.DB.prepare('INSERT INTO room_invites (code_hash, room_id, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .bind(await sha256(code), room.id, user.id, now, now + 7 * 24 * 60 * 60_000).run();
  return c.json({ url: `${c.env.PUBLIC_ORIGIN}/invite/${code}`, expires_at: now + 7 * 24 * 60 * 60_000 }, 201);
});

api.delete('/rooms/:id/invites', async (c) => {
  const user = c.get('user');
  const room = await requireHumanMember(c.env, user, c.req.param('id'));
  if (room.host_user_id !== user.id) throw new HttpError(403, 'HOST_REQUIRED', '招待リンクは主催者のみ失効できます。');
  await c.env.DB.prepare('UPDATE room_invites SET revoked_at = ? WHERE room_id = ? AND revoked_at IS NULL').bind(Date.now(), room.id).run();
  return c.json({ ok: true });
});

api.post('/invites/:code/accept', async (c) => {
  const user = c.get('user');
  const invite = await c.env.DB.prepare('SELECT room_id FROM room_invites WHERE code_hash = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)')
    .bind(await sha256(c.req.param('code')), Date.now()).first<{ room_id: string }>();
  if (!invite) throw new HttpError(404, 'INVITE_NOT_FOUND', '招待リンクが無効か、期限切れです。');
  await c.env.DB.prepare("INSERT OR IGNORE INTO room_members (id, room_id, user_id, kind, joined_at) VALUES (?, ?, ?, 'human', ?)")
    .bind(crypto.randomUUID(), invite.room_id, user.id, Date.now()).run();
  const room = await requireHumanMember(c.env, user, invite.room_id);
  c.executionCtx.waitUntil(roomDirectoryChanged(c.env,room.id));
  return c.json({ room_id: room.id, host_account: room.host_account });
});

api.post('/rooms/:id/join', async (c) => {
  const user = c.get('user');
  const room = await getRoom(c.env, c.req.param('id'));
  if (room.visibility !== 'public' && room.host_user_id !== user.id) throw new HttpError(403, 'INVITE_REQUIRED', 'このルームには招待が必要です。');
  if (!publicAccessEnabled(c.env) && room.host_user_id !== user.id) throw new HttpError(404, 'ROOM_NOT_FOUND', 'ルームが見つかりません。');
  const result = await c.env.DB.prepare(`INSERT OR IGNORE INTO room_members (id, room_id, user_id, kind, joined_at)
    SELECT ?, r.id, ?, 'human', ? FROM rooms r WHERE r.id = ? AND (r.visibility = 'public' OR r.host_user_id=?2)
    AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.user_id = ? AND b.blocked_user_id = r.host_user_id)
      OR (b.blocked_user_id = ? AND b.user_id = r.host_user_id))`)
    .bind(crypto.randomUUID(), user.id, Date.now(), room.id, user.id, user.id).run();
  if (!result.meta.changes) {
    const membership = await c.env.DB.prepare(`SELECT 1 FROM room_members rm JOIN rooms r ON r.id = rm.room_id
      WHERE rm.room_id = ? AND rm.user_id = ? AND rm.kind = 'human' AND (r.visibility = 'public' OR r.host_user_id=?2)
      AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.user_id = ? AND b.blocked_user_id = r.host_user_id)
        OR (b.blocked_user_id = ? AND b.user_id = r.host_user_id))`).bind(room.id, user.id, user.id, user.id).first();
    if (!membership) throw new HttpError(403, 'JOIN_FORBIDDEN', 'このルームには参加できません。');
  }
  c.executionCtx.waitUntil(roomDirectoryChanged(c.env,room.id));
  return c.json({ ok: true });
});

api.delete('/rooms/:id', async (c) => {
  const user = c.get('user');
  const room = await getRoom(c.env, c.req.param('id'));
  if (room.host_user_id !== user.id) throw new HttpError(403, 'HOST_REQUIRED', 'ルームは主催者のみ削除できます。');
  await c.env.DB.prepare('DELETE FROM rooms WHERE id = ? AND host_user_id = ?').bind(room.id, user.id).run();
  if (room.directory_listed) c.executionCtx.waitUntil(broadcastDirectory(c.env));
  return c.json({ ok: true });
});

api.post('/reports', async (c) => {
  const user = c.get('user');
  const body = await jsonBody(c.req.raw);
  const messageId = typeof body.message_id === 'string' ? body.message_id : '';
  const reason = validateText(body.reason, 1000, '通報理由');
  const message = await c.env.DB.prepare(`SELECT m.id FROM messages m JOIN room_members rm ON rm.room_id = m.room_id AND rm.user_id = ? AND rm.kind = 'human'
    WHERE m.id = ? AND m.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM blocks b
      WHERE (b.user_id = ? AND b.blocked_user_id = m.author_user_id) OR (b.blocked_user_id = ? AND b.user_id = m.author_user_id))`)
    .bind(user.id, messageId, user.id, user.id).first();
  if (!message) throw new HttpError(404, 'MESSAGE_NOT_FOUND', 'メッセージが見つかりません。');
  await c.env.DB.prepare('INSERT INTO reports (id, message_id, reporter_user_id, reason, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(crypto.randomUUID(), messageId, user.id, reason, Date.now()).run();
  return c.json({ ok: true }, 201);
});

api.get('/admin/inquiries', async c => {
  if (!c.get('session').operator) throw new HttpError(403, 'OPERATOR_REQUIRED', '運営者のみが確認できます。');
  const rows = await c.env.DB.prepare('SELECT id,category,email,body,created_at FROM site_inquiries WHERE handled_at IS NULL ORDER BY created_at,id LIMIT ? OFFSET ?').bind(...listWindow(c.req.query('offset'), 100)).all();
  return c.json({inquiries:rows.results});
});
api.post('/admin/inquiries/:id/resolve', async c => {
  if (!c.get('session').operator) throw new HttpError(403, 'OPERATOR_REQUIRED', '運営者のみが確認できます。');
  const result = await c.env.DB.prepare('UPDATE site_inquiries SET handled_at=? WHERE id=? AND handled_at IS NULL').bind(Date.now(),c.req.param('id')).run();
  if (!result.meta.changes) throw new HttpError(404,'NOT_FOUND','未対応のお問い合わせが見つかりません。');
  return c.json({ok:true});
});

api.get('/admin/reports', async (c) => {
  if (!c.get('session').operator) throw new HttpError(403, 'OPERATOR_REQUIRED', '運営者のみが確認できます。');
  const reports = await c.env.DB.prepare(`SELECT r.id, r.reason, r.created_at, r.handled_at,
    CASE WHEN reporter.is_guest = 1 THEN '匿名' ELSE reporter.account_name END AS reporter,
    CASE WHEN author.is_guest = 1 THEN '匿名' ELSE author.account_name END AS author, m.body AS message_body, m.deleted_at AS unavailable_at
    FROM reports r JOIN users reporter ON reporter.id = r.reporter_user_id JOIN messages m ON m.id = r.message_id
    JOIN users author ON author.id = m.author_user_id ORDER BY r.created_at DESC,r.id LIMIT ? OFFSET ?`).bind(...listWindow(c.req.query('offset'), 100)).all();
  return c.json({ reports: reports.results });
});

api.post('/admin/reports/:id/hide', async c => {
  if (!c.get('session').operator) throw new HttpError(403,'OPERATOR_REQUIRED','運営者のみ操作できます。');
  const id = c.req.param('id'), now = Date.now();
  const [hidden, handled] = await c.env.DB.batch<{ id:string }>([
    c.env.DB.prepare(`UPDATE messages SET deleted_at=?1, moderation_hidden_at=?1
      WHERE id=(SELECT message_id FROM reports WHERE id=?2) AND deleted_at IS NULL RETURNING id`).bind(now,id),
    c.env.DB.prepare('UPDATE reports SET handled_at=COALESCE(handled_at,?) WHERE id=?').bind(now,id),
  ]);
  if (!handled.meta.changes) throw new HttpError(404,'REPORT_NOT_FOUND','通報が見つかりません。');
  const message = hidden.results[0]?.id;
  if (typeof message === 'string') c.executionCtx.waitUntil(messageDirectoryChanged(c.env,message));
  return c.json({ok:true});
});

api.post('/admin/reports/:id/resolve', async (c) => {
  if (!c.get('session').operator) throw new HttpError(403, 'OPERATOR_REQUIRED', '運営者のみが確認できます。');
  const result = await c.env.DB.prepare('UPDATE reports SET handled_at = ? WHERE id = ? AND handled_at IS NULL')
    .bind(Date.now(), c.req.param('id')).run();
  if (!result.meta.changes) throw new HttpError(404, 'REPORT_NOT_FOUND', '未対応の通報が見つかりません。');
  return c.json({ ok: true });
});

api.get('/blocks', async (c) => {
  const blocks = await c.env.DB.prepare(`SELECT b.blocked_user_id, u.account_name, b.created_at FROM blocks b
    JOIN users u ON u.id = b.blocked_user_id WHERE b.user_id = ? ORDER BY b.created_at DESC`).bind(c.get('user').id).all();
  return c.json({ blocks: blocks.results });
});

api.post('/blocks', async (c) => {
  const user = c.get('user');
  const body = await jsonBody(c.req.raw);
  const account = validateAccountName(body.account_name);
  const target = await c.env.DB.prepare('SELECT id FROM users WHERE is_guest=0 AND account_name=?').bind(account).first<{ id: string }>();
  if (!target) throw new HttpError(404, 'USER_NOT_FOUND', 'アカウントが見つかりません。');
  if (target.id === user.id) throw new HttpError(400, 'SELF_BLOCK', '自分自身はブロックできません。');
  await c.env.DB.prepare('INSERT OR IGNORE INTO blocks (user_id, blocked_user_id, created_at) VALUES (?, ?, ?)').bind(user.id, target.id, Date.now()).run();
  return c.json({ ok: true }, 201);
});

api.delete('/blocks/:userId', async (c) => {
  await c.env.DB.prepare('DELETE FROM blocks WHERE user_id = ? AND blocked_user_id = ?').bind(c.get('user').id, c.req.param('userId')).run();
  return c.json({ ok: true });
});

api.get('/notification-settings', async (c) => {
  const row = await c.env.DB.prepare('SELECT mention_enabled FROM notification_settings WHERE user_id = ?')
    .bind(c.get('user').id).first<{ mention_enabled: number }>();
  return c.json(row ?? { mention_enabled: 1 });
});

api.put('/notification-settings', async (c) => {
  const body = await jsonBody(c.req.raw);
  if (typeof body.mention_enabled !== 'boolean') throw new HttpError(400, 'INVALID_SETTINGS', '通知設定を確認してください。');
  await c.env.DB.prepare(`INSERT INTO notification_settings (user_id, mention_enabled) VALUES (?, ?)
    ON CONFLICT(user_id) DO UPDATE SET mention_enabled = excluded.mention_enabled`)
    .bind(c.get('user').id, Number(body.mention_enabled)).run();
  return c.json({ ok: true });
});

const noticeSentences = new Intl.Segmenter('ja', { granularity: 'sentence' });

function replyExcerpt(sample: string) {
  const characters = Array.from(sample);
  if (characters.length <= 80) return sample;
  const prefix = characters.slice(0, 80).join('');
  let end = 0;
  for (const part of noticeSentences.segment(sample)) {
    if (part.index + part.segment.length > prefix.length) break;
    end = part.index + part.segment.length;
  }
  return end ? sample.slice(0, end).trimEnd() : prefix.trimEnd() + '…';
}

api.get('/inbox/live', c => subscribeInbox(c.env, c.req.raw, c.get('session')));
api.get('/inbox/latest', async c => c.json(await latestIncoming(c.env, c.get('user').id, c.req.query('after'))));

api.get('/notifications', async (c) => {
  const user = c.get('user');
  const result = await c.env.DB.prepare(`SELECT n.id, n.kind,
    CASE WHEN n.kind='reply' AND m.body IS NOT NULL THEN
      substr(m.body,1,81)
      ELSE n.body END AS body,
    n.room_id, n.created_at, n.read_at, m.id AS source_message_id, m.seq AS source_seq FROM notifications n
    LEFT JOIN messages m ON m.room_id = n.room_id AND m.id = COALESCE(n.source_message_id,
      CASE WHEN n.kind = 'privacy_warning' THEN (SELECT MIN(old.id) FROM messages old
        WHERE old.room_id = n.room_id AND old.author_user_id = n.user_id AND old.author_agent_id IS NOT NULL
          AND old.created_at = n.created_at HAVING COUNT(*) = 1) END)
    WHERE n.user_id = ? AND n.kind <> 'digest' AND m.deleted_at IS NULL AND (n.source_message_id IS NULL OR m.id IS NOT NULL) AND (n.source_user_id IS NULL OR NOT EXISTS (SELECT 1 FROM blocks b
      WHERE (b.user_id = ? AND b.blocked_user_id = n.source_user_id) OR (b.blocked_user_id = ? AND b.user_id = n.source_user_id)))
    AND (n.room_id IS NULL OR EXISTS (SELECT 1 FROM room_members rm WHERE rm.room_id = n.room_id AND rm.user_id = ? AND rm.kind = 'human'))
    ORDER BY n.created_at DESC,n.id LIMIT ? OFFSET ?`).bind(user.id, user.id, user.id, user.id, ...listWindow(c.req.query('offset'), 100)).all<{ kind: string; body: string }>();
  return c.json({ notifications: result.results.map(n => n.kind === 'reply' ? { ...n, body: replyExcerpt(n.body) } : n) });
});

api.post('/notifications/:id/read', async (c) => {
  await c.env.DB.prepare(`UPDATE notifications SET read_at=?1 WHERE user_id=?3 AND read_at IS NULL AND
    (id=?2 OR (kind='reply' AND room_id=(
      SELECT room_id FROM notifications WHERE id=?2 AND user_id=?3 AND kind='reply'
    )))`)
    .bind(Date.now(), c.req.param('id'), c.get('user').id).run();
  return c.json({ ok: true });
});

api.get('/agents/:id/webhook', async c => {
  const agent = await ownedAgent(c.env, c.get('user').id, c.req.param('id'));
  const hook = await getWebhook(c.env,{agentId:agent.id,ownerId:agent.owner_id});
  const logs = await c.env.DB.prepare('SELECT id,created_at,attempt,success,status FROM webhook_logs WHERE agent_id = ? ORDER BY id DESC LIMIT ? OFFSET ?')
    .bind(agent.id, ...listWindow(c.req.query('offset'), 50)).all();
  return c.json({ hook, logs: logs.results });
});
api.put('/agents/:id/webhook', async c => {
  const agent = await ownedAgent(c.env, c.get('user').id, c.req.param('id'));
  const {url} = await jsonBody(c.req.raw);
  return c.json(await changeWebhook(c.env,{agentId:agent.id,ownerId:agent.owner_id},{url}));
});
api.delete('/agents/:id/webhook', async c => {
  const agent = await ownedAgent(c.env, c.get('user').id, c.req.param('id'));
  return c.json(await changeWebhook(c.env,{agentId:agent.id,ownerId:agent.owner_id},null));
});

api.post('/rooms/:id/media-messages', async c => {
  const room = c.req.param('id');
  const user = c.get('user');
  await requireHumanMember(c.env,user,room);
  await enforceIpRate(c.env,c.req.raw,'chat-upload',60,3600_000);
  const upload = await prepareUpload(c.req.raw);
  const id = await postHumanMessage(c.env,user,room,upload.body,upload.reply,upload.media);
  c.executionCtx.waitUntil(signalMessage(c.env,id));
  return c.json({ id },201);
});
api.put('/rooms/:id/messages/:message/reaction', async c => {
  const room = c.req.param('id');
  const user = c.get('user');
  await requireHumanMember(c.env,user,room);
  const data = await jsonBody(c.req.raw);
  return c.json({ reactions: await setReaction(c.env,user,room,c.req.param('message'),data.emoji) });
});
api.get('/rooms/:id/attachments/:file', async c => {
  const room = c.req.param('id');
  return serveAttachment(c.env,c.get('user').id,room,c.req.param('file'),c.req.raw);
});
