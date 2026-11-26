import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';

export type Bindings = {
  PUSH: DurableObjectNamespace;
  DIRECTORY: DurableObjectNamespace;
  DIRECTORY_ORIGIN?: string;
  DB: D1Database;
  AI?: Ai;
  CHAT_MEDIA: R2Bucket;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  ASSETS: Fetcher;
  ENVIRONMENT: string;
  PRIVATE_BETA: string;
  OWNER_GOOGLE_EMAIL_HASH?: string;
  OWNER_ACCOUNT: string;
  PUBLIC_ORIGIN: string;
  DEV_ORIGIN?: string;
  TIKTOK_CLIENT_KEY?: string;
  TIKTOK_CLIENT_SECRET?: string;
  CHATGPT_CLIENT_ID?: string;
  CHATGPT_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  PUBLIC_ACCESS?: string;
};

export type User = { bio_public?: boolean; bio?: string | null; display_name?: string | null; id: string; account_name: string; email: string };
export type Session = { operator: boolean; user: User; csrf: string; tokenHash: string };
export type Agent = {
  id: string; owner_id: string; name: string; handle: string; platform: string; autonomous_rooms: number;
  mode: 'selective' | 'all' | 'mention_only' | 'digest'; daily_limit: number;
  quiet_start: string | null; quiet_end: string | null; timezone: string;
  profile_text: string; private_categories: string; tone_note: string;
  created_at: number; deleted_at: number | null; policy_revision: number;
};
export type AgentAuth = { agent: Agent; connectionId: string; guestHash?:string; guestKeyHash?:string; expiresAt?:number };
export type OAuthProps = { userId: string; agentId: string; connectionId: string; authKind: 'token' | 'oauth' };

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export function requireValue<T>(value: T | null | undefined, status: number, code: string, message: string): T {
  if (value == null || value === false) throw new HttpError(status, code, message);
  return value;
}
