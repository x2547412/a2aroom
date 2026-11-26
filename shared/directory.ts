export const directoryOrigin = 'https://a2aroom.com';
export const directoryAppOrigin = 'https://app.a2aroom.com';
export const directoryAvatarPath = '/api/account/avatar';
export const directorySessionPath = '/api/session/status';

export function isAccountOrigin(origin: string) {
  return /^https:\/\/[a-z0-9-]{3,32}\.a2aroom\.com$/.test(origin) && origin !== 'https://staging.a2aroom.com';
}

export function publicRoomsUrl(origin: string, search = '') {
  const production = isAccountOrigin(origin) || origin === directoryOrigin;
  const url = production ? new URL('/', directoryOrigin) : new URL('/explore', origin);
  for (const [key, value] of new URLSearchParams(search)) {
    if (['tag', 'sort', 'mode'].includes(key)) url.searchParams.set(key, value);
  }
  return url.href;
}

export function directoryRoomPath(id: string, source: 'public' | 'my-rooms', tag?: string | null) {
  const params = new URLSearchParams({ from: source });
  if (tag) params.set('tag', tag);
  return '/rooms/' + encodeURIComponent(id) + '?' + params;
}

export function roomDirectoryReturn(origin: string, search: string) {
  const source = new URLSearchParams(search).get('from');
  if (source !== 'public' && source !== 'my-rooms') return null;
  const url = new URL(publicRoomsUrl(origin, search));
  if (source === 'my-rooms') url.searchParams.set('screen', 'inbox');
  return url.href;
}

export const directorySorts = { popular: '人気順', members: '参加者数順', recent: '新着順' } as const;
export type DirectorySort = keyof typeof directorySorts;
export type DirectoryRoom = {
  id: string;
  name: string;
  description: string;
  host_account: string;
  access_mode: 'registered' | 'anonymous';
  tags: string[];
  joined: number;
  participants: { kind: 'human' | 'agent'; name: string }[] | null;
  message_count: number;
  human_count: number;
  agent_count: number;
  active_count: number;
  created_at: number;
};
export type DirectoryPage = { rooms: DirectoryRoom[]; more: boolean; app_origin: string; participation_open: boolean };
export const pageSize = 24;
export const maxTags = 5;
export const maxTagLength = 24;
export function tagLabel(value: string) {
  return value.normalize('NFKC').trim().replace(/^#+/u, '');
}
export function isValidTag(label: string) {
  return Boolean(label) && [...label].length <= maxTagLength && !/[\s#,、\p{Cc}]/u.test(label);
}
export function splitTags(text: string) {
  const tags = new Map<string, string>();
  for (const raw of text.normalize('NFKC').split(/[\s,、]+/u)) {
    const label = tagLabel(raw),
      key = label.toLowerCase();
    if (label && !tags.has(key)) tags.set(key, label);
  }
  return [...tags.values()];
}
