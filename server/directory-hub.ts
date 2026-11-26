import { requireOrigin } from './security';
import { HttpError, type Bindings } from './types';

const channel = 'public-room-directory';
function hub(env: Bindings, name: string) {
  return env.DIRECTORY.get(env.DIRECTORY.idFromName(name));
}

export function subscribeChanges(env: Bindings, request: Request, name: string) {
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
    throw new HttpError(426, 'UPGRADE_REQUIRED', 'WebSocketで接続してください。');
  requireOrigin(request, env);
  return hub(env, name).fetch('https://directory.internal/listen', { headers: { Upgrade: 'websocket' } });
}

export async function broadcastChange(env: Bindings, name: string) {
  const response = await hub(env, name).fetch('https://directory.internal/changed', { method: 'POST' });
  if (!response.ok) throw new Error('Change notification failed');
}

export function subscribeDirectory(env: Bindings, request: Request) {
  return subscribeChanges(env, request, channel);
}

export function broadcastDirectory(env: Bindings) {
  return broadcastChange(env, channel);
}

export async function roomDirectoryChanged(env: Bindings, roomId: string) {
  const listed = await env.DB.prepare("SELECT 1 FROM rooms WHERE id=? AND directory_listed=1 AND visibility='public'")
    .bind(roomId)
    .first();
  if (listed) await broadcastDirectory(env);
}

export async function messageDirectoryChanged(env: Bindings, messageId: string) {
  const listed = await env.DB.prepare(
    `SELECT 1 FROM messages m JOIN rooms r ON r.id=m.room_id
    WHERE m.id=? AND r.directory_listed=1 AND r.visibility='public'`,
  )
    .bind(messageId)
    .first();
  if (listed) await broadcastDirectory(env);
}

export async function agentDirectoryChanged(env: Bindings, agentId: string) {
  const listed = await env.DB.prepare(`SELECT 1 FROM room_members m JOIN rooms r ON r.id=m.room_id
    WHERE m.agent_id=? AND r.directory_listed=1 AND r.visibility='public' LIMIT 1`).bind(agentId).first();
  if (listed) await broadcastDirectory(env);
}

// Only an invalidation is broadcast. Each reader reloads its own authorized view.
export class DirectoryHub {
  constructor(private readonly state: DurableObjectState) {}
  async fetch(request: Request) {
    const path = new URL(request.url).pathname;
    if (path === '/listen' && request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      this.state.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (path === '/changed' && request.method === 'POST') {
      for (const socket of this.state.getWebSockets()) {
        try {
          socket.send('changed');
        } catch {
          socket.close(1011, 'Reconnect');
        }
      }
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 404 });
  }
  webSocketMessage(socket: WebSocket) {
    socket.close(1008, 'Read only');
  }
  webSocketError(socket: WebSocket) {
    socket.close(1011, 'Reconnect');
  }
  webSocketClose(socket: WebSocket) {
    socket.close();
  }
}
