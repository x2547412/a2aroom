import { directoryOrigin, directoryAppOrigin, directorySessionPath } from '../shared/directory';
import { locale, ui } from './language';
import type { Attachment, Reaction, StickerId } from '../shared/chat';
export type User = { bio_public?: boolean; bio?: string | null; display_name?: string | null; id: string; account_name: string; email: string };
export type Agent = {
  id: string; owner_id: string; name: string; handle: string; platform: string; autonomous_rooms: number;
  mode: 'selective' | 'all' | 'mention_only' | 'digest'; daily_limit: number; quiet_start: string | null; quiet_end: string | null;
  timezone: string; profile_text: string; private_categories: string[]; tone_note: string; created_at: number;
};
export type Connection = { id: string; agent_id: string; label: string; kind: string; created_at: number; revoked_at: number | null };
export type AccessMode = 'invite' | 'registered' | 'anonymous';
export type RoomPortrait = { kind: 'human' | 'agent'; id: string; name: string; image_version?: number | null };
export type Room = { tags?: string[]; directory_listed?: number; member_count?: number; portraits?: RoomPortrait[]; id: string; name: string; description: string; visibility: 'public' | 'invite'; access_mode: AccessMode; host_account: string; host_user_id?: string; host_display_name?: string | null; created_at: number; last_body?: string | null; last_message_at?: number | null; unread_count?: number };
export type InboxRoom = Room & { human_count: number; agent_count: number; message_count: number };
export type Member = { display_name?: string | null; id: string; kind: 'human' | 'agent'; user_id: string; agent_id: string | null; account_name: string; agent_name: string | null; handle: string | null; platform: string | null };
export type Message = { has_note?:number; has_correction?:number; display_name?: string | null; current_agent_name?: string | null; read_count?: number; attachments?: Attachment[]; reactions?: Reaction[]; sticker_id?: StickerId | null; media_label_only?: number; seq: number; id: string; room_id: string; author_user_id: string; author_agent_id: string | null; is_guest?: number; account_name: string; agent_name: string | null; platform: string | null; body: string; reply_to: string | null; created_at: number; edited_at: number | null; read_by?: Array<{ agent_id: string; agent_name: string; account_name: string }> };
export type Notice = { source_message_id: string | null; source_seq: number | null; id: string; kind: string; body: string; room_id: string | null; created_at: number; read_at: number | null };
export type SessionResponse = { authenticated: false; needsSetup: boolean; publicAccess?: boolean } | { authenticated: true; user: User; csrf: string; privateBeta: boolean; publicAccess?: boolean; operator: boolean };

let csrf = '';
export function setCsrf(value: string) { csrf = value; }

export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export async function request<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  return fetchApi<T>('/api' + path, options.method ?? 'GET', options.body, csrf);
}

export function publicRequest<T>(path: string, options: { method?: string; body?: unknown; csrf?: string } = {}): Promise<T> {
  return fetchApi<T>('/api/public' + path, options.method ?? 'GET', options.body, options.csrf);
}

async function fetchApi<T>(url: string, method: string, value: unknown, token?: string): Promise<T> {
  const headers: Record<string, string> = {};
  const multipart = value instanceof FormData;
  if (value !== undefined && !multipart) headers['Content-Type'] = 'application/json';
  if (token && method !== 'GET') headers['X-CSRF-Token'] = token;
  const response = await fetch(url, { method, headers, body: multipart ? value : JSON.stringify(value), credentials: 'same-origin' });
  const data = await response.json() as T & { message?: string };
  if (!response.ok) throw new ApiError(data.message || ui(`通信に失敗しました（${response.status}）`, `Request failed (${response.status})`), response.status);
  return data;
}

export function time(value: number): string {
  return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

export function dateLabel(value: number): string {
  const date = new Date(value);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return time(value);
  return new Intl.DateTimeFormat(locale, { month: 'numeric', day: 'numeric' }).format(date);
}

let pendingSession: Promise<SessionResponse> | undefined;
export function browserSession(): Promise<SessionResponse> {
  if (location.origin !== directoryOrigin) return request('/session');
  pendingSession ??= syncDirectorySession().finally(() => { pendingSession = undefined; });
  return pendingSession;
}

async function syncDirectorySession(): Promise<SessionResponse> {
  const response = await fetch(directoryAppOrigin + directorySessionPath, {
    method: 'POST', credentials: 'include', redirect: 'error', cache: 'no-store',
  });
  if (!response.ok) throw new Error(ui('ログイン状態を確認できませんでした。','Could not check sign-in status.'));
  const {ticket} = await response.json() as {ticket: string};
  const accepted = await fetch('/api/workspace/session', {
    method: 'POST', body: new URLSearchParams({ ticket }), redirect: 'error',
  });
  if (!accepted.ok) throw new Error(ui('ログイン状態を確認できませんでした。','Could not check sign-in status.'));
  return request('/session');
}
