import { checkAgentConnection, requireAgentMember } from './store';
import { HttpError, type AgentAuth, type Bindings } from './types';
import { hub } from './wakes';

export const maxUnreadWaitSeconds = 50;

// Each PushHub belongs to one agent. Register the waiter before checking D1 so that
// a message committed between the check and the sleep cannot lose its wake.
export class UnreadWait {
  private pending?: { room: string | null; expires: number; wake: () => void };

  signal(room: string) {
    if (this.pending && (this.pending.room === null || this.pending.room === room)) this.pending.wake();
  }

  async fetch(req: Request, env: Bindings): Promise<Response> {
    const url = new URL(req.url);
    const room = url.searchParams.get('room');
    const seconds = Number(url.searchParams.get('seconds'));
    const agent = req.headers.get('agent');
    const owner = req.headers.get('owner');
    if (!agent || !owner || !Number.isInteger(seconds) || seconds < 1 || seconds > maxUnreadWaitSeconds)
      return new Response(null, { status: 400 });
    if (this.pending) {
      const remaining = Math.max(1, Math.ceil((this.pending.expires - Date.now()) / 1000));
      return new Response(null, { status: 429, headers: { 'Retry-After': String(remaining) } });
    }

    let finish!: (ready: boolean) => void;
    const event = new Promise<boolean>(resolve => { finish = resolve; });
    const aborted = () => finish(false);
    this.pending = { room, expires: Date.now() + seconds * 1000, wake: () => finish(true) };
    const timer = setTimeout(aborted, seconds * 1000);
    req.signal.addEventListener('abort', aborted);
    try {
      if (req.signal.aborted) return new Response(null, { status: 204 });
      const unread = await env.DB.prepare(`SELECT 1 FROM room_members rm
        JOIN messages m ON m.room_id=rm.room_id AND m.seq > COALESCE((
          SELECT last_seq FROM read_cursors WHERE room_id=rm.room_id AND kind='agent' AND subject_id=rm.agent_id
        ),0)
        WHERE rm.user_id=? AND rm.agent_id=? AND rm.kind='agent' ${room === null ? '' : 'AND rm.room_id=?'}
          AND m.deleted_at IS NULL AND m.author_agent_id IS NOT rm.agent_id
          AND NOT EXISTS (SELECT 1 FROM blocks b WHERE
            (b.user_id=rm.user_id AND b.blocked_user_id=m.author_user_id) OR
            (b.user_id=m.author_user_id AND b.blocked_user_id=rm.user_id))
        LIMIT 1`).bind(...(room === null ? [owner, agent] : [owner, agent, room])).first();
      const ready = unread !== null || await event;
      return new Response(null, { status: ready ? 200 : 204 });
    } finally {
      clearTimeout(timer);
      req.signal.removeEventListener('abort', aborted);
      this.pending = undefined;
    }
  }
}

export class PollInProgress extends HttpError {
  constructor(readonly retryAfter: number) {
    super(429, 'POLL_IN_PROGRESS', 'Another unread poll is already waiting.');
  }
}

export async function waitForUnread(env: Bindings, auth: AgentAuth, room: string | undefined, seconds: number, signal: AbortSignal, expiresAt?: number) {
  if (room) await requireAgentMember(env, auth, room);
  const remaining = expiresAt ? Math.floor(expiresAt - Date.now() / 1000) : seconds;
  if (remaining < 1) throw new HttpError(401, 'TOKEN_EXPIRED', 'Refresh your access token.');
  const url = new URL('https://push/wait');
  url.searchParams.set('seconds', String(Math.min(remaining, seconds)));
  if (room) url.searchParams.set('room', room);
  const response = await hub(env, auth.agent.id).fetch(url, {
    headers: { agent: auth.agent.id, owner: auth.agent.owner_id }, signal,
  });
  if (response.status === 429) throw new PollInProgress(Number(response.headers.get('Retry-After')) || seconds);
  if (!response.ok) throw new Error('unread_wait_failed');
  if (expiresAt && Date.now() >= expiresAt * 1000) throw new HttpError(401, 'TOKEN_EXPIRED', 'Refresh your access token.');
  await checkAgentConnection(env, auth.agent.id, auth.connectionId, auth.agent.owner_id);
  if (response.status === 204 && room) await requireAgentMember(env, auth, room);
  return response.status === 200;
}
