import {
  directorySorts,
  isValidTag,
  maxTagLength,
  maxTags,
  pageSize,
  tagLabel,
  type DirectoryRoom,
  type DirectorySort,
} from '../shared/directory';
import { publicAccessEnabled } from './public-access';
import { HttpError, type Bindings } from './types';

export function parseTags(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 32)
    throw new HttpError(400, 'INVALID_TAGS', 'タグを配列で指定してください。');
  const labels = new Map<string, string>();
  for (const raw of value) {
    if (typeof raw !== 'string') throw new HttpError(400, 'INVALID_TAGS', 'タグを確認してください。');
    const label = tagLabel(raw);
    if (!isValidTag(label))
      throw new HttpError(400, 'INVALID_TAG', 'タグは空白を含まない24文字以内で指定してください。');
    if (!labels.has(label.toLowerCase())) labels.set(label.toLowerCase(), label);
  }
  if (labels.size > maxTags) throw new HttpError(400, 'TOO_MANY_TAGS', 'タグは5個まで設定できます。');
  return [...labels.values()];
}

export function writeTags(env: Bindings, room: string, labels: string[]) {
  return labels.map((label) =>
    env.DB.prepare('INSERT INTO room_tags(room_id,tag_key,label) VALUES(?,?,?)').bind(room, label.toLowerCase(), label),
  );
}

export function readTags(env: Bindings, room: string) {
  return env.DB.prepare('SELECT label FROM room_tags WHERE room_id=? ORDER BY tag_key').bind(room);
}

export async function changeTags(env: Bindings, room: string, operation: unknown, value: unknown) {
  const labels = parseTags(value);
  if ((operation !== 'add' && operation !== 'remove') || !labels.length)
    throw new HttpError(400, 'INVALID_TAG_CHANGE', '追加または削除するタグを指定してください。');
  const incoming = JSON.stringify(Object.fromEntries(labels.map(label => [label.toLowerCase(), label])));
  // Check the merged size inside the insert so concurrent edits cannot exceed the limit.
  const change = operation === 'add'
    ? env.DB.prepare(`INSERT INTO room_tags(room_id,tag_key,label)
        SELECT ?1, key, value FROM json_each(?2)
        WHERE (SELECT COUNT(*) FROM (SELECT tag_key FROM room_tags WHERE room_id=?1 UNION SELECT key FROM json_each(?2))) <= ?3
        ON CONFLICT(room_id,tag_key) DO NOTHING`).bind(room, incoming, maxTags)
    : env.DB.prepare('DELETE FROM room_tags WHERE room_id=?1 AND tag_key IN (SELECT key FROM json_each(?2))').bind(room, incoming);
  const [, snapshot] = await env.DB.batch<{ label: string }>([change, readTags(env, room)]);
  const tags = snapshot.results.map(row => row.label);
  const keys = new Set(tags.map(tag => tag.toLowerCase()));
  if (operation === 'add' && labels.some(label => !keys.has(label.toLowerCase())))
    throw new HttpError(409, 'TOO_MANY_TAGS', `タグは${maxTags}個まで設定できます。`);
  return tags;
}

const listedRoom = "r.directory_listed=1 AND r.visibility='public' AND r.access_mode IN ('registered','anonymous')";
const hostVisibleTo = (viewer: '?1' | '?3') => `NOT EXISTS (
  SELECT 1 FROM blocks b WHERE (b.user_id=${viewer} AND b.blocked_user_id=r.host_user_id)
    OR (b.blocked_user_id=${viewer} AND b.user_id=r.host_user_id))`;

export async function popularRoomTags(env: Bindings, viewer: string) {
  const now = Date.now();
  const since = now - 30 * 24 * 60 * 60_000;
  // A room has at most one row per normalized tag. Fetch spare candidates for tags already selected.
  const rows = await env.DB.prepare(`SELECT MIN(t.label) AS label
    FROM rooms r JOIN room_tags t ON t.room_id=r.id
    WHERE ${listedRoom} AND r.created_at BETWEEN ?2 AND ?3 AND ${hostVisibleTo('?1')}
    GROUP BY t.tag_key ORDER BY COUNT(*) DESC, t.tag_key LIMIT ?4`)
    .bind(viewer, since, now, maxTags * 2).all<{label: string}>();
  return rows.results.map(row => row.label);
}

const orders: Record<DirectorySort, string> = {
  popular: 'active_count DESC, (human_count + agent_count) DESC, created_at DESC',
  members: '(human_count + agent_count) DESC, active_count DESC, created_at DESC',
  recent: 'created_at DESC',
};

export function roomMessageCount(room: 'v.id' | 'r.id', viewer: '?1' | '?3') {
  return `(SELECT COUNT(*) FROM messages msg WHERE msg.room_id=${room} AND msg.deleted_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.user_id=${viewer} AND b.blocked_user_id=msg.author_user_id)
      OR (b.blocked_user_id=${viewer} AND b.user_id=msg.author_user_id)))`;
}

export async function directoryPage(env: Bindings, url: URL, viewer = '', hostId: string | null = null, includeMembership = false) {
  const params = url.searchParams;
  const sort = params.get('sort') ?? 'popular';
  const mode = params.get('mode') ?? 'all';
  const tag = tagLabel(params.get('tag') ?? '').toLowerCase();
  const page = Number(params.get('page') ?? 1);
  if (
    !Object.hasOwn(directorySorts, sort) ||
    !['all', 'registered', 'anonymous'].includes(mode) ||
    [...tag].length > maxTagLength ||
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > 100000
  ) {
    throw new HttpError(400, 'DIRECTORY_FILTER', '検索条件を確認してください。');
  }
  const now = Date.now();
  const open = publicAccessEnabled(env);
  const result = await env.DB.prepare(
    `WITH visible AS (
    SELECT r.id, r.name, r.description, r.access_mode, r.created_at, CASE WHEN u.is_guest=1 THEN '匿名' ELSE u.account_name END AS host_account,
      ${includeMembership ? `EXISTS (SELECT 1 FROM room_members own WHERE own.room_id=r.id AND own.kind='human' AND own.user_id=?3)` : '0'} AS joined
    FROM rooms r JOIN users u ON u.id=r.host_user_id
    WHERE ${listedRoom}
    AND (?9 IS NULL OR r.host_user_id=?9)
    AND (?1='all' OR r.access_mode=?1)
    AND (?2='' OR EXISTS (SELECT 1 FROM room_tags t WHERE t.room_id=r.id AND instr(t.tag_key,?2)>0))
    AND ${hostVisibleTo('?3')}
  ), members AS (
    SELECT rm.room_id, rm.id, rm.user_id, rm.agent_id, rm.kind, rm.joined_at, u.is_guest, u.account_name, u.display_name
    FROM visible v JOIN room_members rm ON rm.room_id=v.id JOIN users u ON u.id=rm.user_id
    WHERE (u.is_guest=0 OR EXISTS (SELECT 1 FROM guest_sessions g WHERE g.room_id=rm.room_id AND g.user_id=u.id AND g.expires_at>?4))
      AND (rm.kind='human' OR EXISTS (SELECT 1 FROM agents a WHERE a.id=rm.agent_id AND a.deleted_at IS NULL))
  ), counts AS (
    SELECT room_id, SUM(kind='human') AS humans, SUM(kind='agent') AS agents FROM members GROUP BY room_id
  ), activity AS (
    SELECT m.room_id, COUNT(DISTINCT COALESCE('a:'||m.author_agent_id, 'h:'||m.author_user_id)) AS active
    FROM visible v JOIN messages m ON m.room_id=v.id WHERE m.created_at>=?5 AND m.deleted_at IS NULL GROUP BY m.room_id
  )
  SELECT v.*, ${roomMessageCount('v.id','?3')} AS message_count,
    CASE WHEN v.joined=1 OR (?8=1 AND v.access_mode='anonymous') THEN
      (SELECT json_group_array(json_object('kind',kind,'name',display_name)) FROM (
        SELECT m.kind, CASE WHEN m.is_guest=1 THEN COALESCE(m.display_name,'匿名') WHEN m.kind='agent' THEN a.name ELSE m.account_name END AS display_name
        FROM members m LEFT JOIN agents a ON a.id=m.agent_id WHERE m.room_id=v.id
        AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.user_id=?3 AND b.blocked_user_id=m.user_id) OR (b.blocked_user_id=?3 AND b.user_id=m.user_id))
        ORDER BY m.joined_at,m.id LIMIT 6)) ELSE NULL END AS participants,
    COALESCE(c.humans,0) AS human_count, COALESCE(c.agents,0) AS agent_count, COALESCE(a.active,0) AS active_count,
    (SELECT json_group_array(label) FROM (SELECT label FROM room_tags t WHERE t.room_id=v.id ORDER BY t.tag_key)) AS tags
  FROM visible v LEFT JOIN counts c ON c.room_id=v.id LEFT JOIN activity a ON a.room_id=v.id
  ORDER BY ${orders[sort as DirectorySort]}, v.id LIMIT ?6 OFFSET ?7`,
  )
    .bind(mode, tag, viewer, now, now - 24 * 60 * 60_000, pageSize + 1, (page - 1) * pageSize, Number(open), hostId)
    .all<Omit<DirectoryRoom, 'tags' | 'participants'> & { tags: string; participants: string | null }>();
  return {
    rooms: result.results
      .slice(0, pageSize)
      .map((row) => ({
        ...row,
        tags: JSON.parse(row.tags) as string[],
        participants:
          row.participants === null ? null : (JSON.parse(row.participants) as DirectoryRoom['participants']),
      })),
    more: result.results.length > pageSize,
    app_origin: env.PUBLIC_ORIGIN,
    participation_open: open,
  };
}
