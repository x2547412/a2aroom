import { UnreadWait } from './unread-wait';
import { checkAgentConnection } from './store';
import { HttpError, type Bindings } from './types';
import { deliverOne } from './webhook';
import { retention, visible, wakeMethod, wakePayload } from './wakes';

type Listener = {
  connection: string; stream: string; seq: number; expires: number;
  controller: ReadableStreamDefaultController<Uint8Array>; pending: Promise<void>;
};
const encoder = new TextEncoder();
export class PushHub {
  private unreadWait = new UnreadWait();
  private listeners = new Set<Listener>();
  constructor(private state: DurableObjectState, private env: Bindings) {}

  private async flush(agent: string, listener: Listener) {
    do {
      await checkAgentConnection(this.env, agent, listener.connection);
      const page = await visible(this.env, agent, ' AND e.seq > ? AND m.created_at >= ? ORDER BY e.seq LIMIT 50', listener.seq, Date.now() - retention);
      for (const row of page.results) {
        if (!this.listeners.has(listener)) return;
        if (Date.now() >= listener.expires || (listener.controller.desiredSize ?? 0) <= 0) {
          this.close(listener);
          return;
        }
        const message = { jsonrpc: '2.0', method: wakeMethod, params: wakePayload(row) };
        listener.controller.enqueue(encoder.encode(`id: ${listener.stream}.${row.seq}\nevent: message\ndata: ${JSON.stringify(message)}\n\n`));
        listener.seq = row.seq;
      }
      if (page.results.length < 50) return;
    } while (this.listeners.has(listener));
  }
  private queue(agent: string, listener: Listener) {
    listener.pending = listener.pending.then(() => this.flush(agent, listener)).catch(error => {
      this.close(listener);
      if (!(error instanceof HttpError && error.status === 401)) console.error('push_stream_failed');
    });
    return listener.pending;
  }
  private close(listener: Listener) {
    if (this.listeners.delete(listener)) listener.controller.close();
  }
  async fetch(req: Request) {
    if (new URL(req.url).pathname === '/wait') return this.unreadWait.fetch(req, this.env);
    if (req.method === 'POST') {
      const room = req.headers.get('wake-room');
      if (room) this.unreadWait.signal(room);
      const agent = await req.text();
      if (await this.state.storage.get<string>('agent') !== agent) await this.state.storage.put('agent', agent);
      await Promise.all([this.schedule(agent), ...Array.from(this.listeners, l => this.queue(agent, l))]);
      return new Response(null, { status: 204 });
    }
    const agent = req.headers.get('agent')!;
    const connection = req.headers.get('connection')!;
    const expires = Math.min(Date.now() + 300_000, Number(req.headers.get('expires')));
    const last = req.headers.get('Last-Event-ID');
    let stream = connection + '.' + crypto.randomUUID();
    let seq: number;
    if (last) {
      const parts = last.split('.');
      seq = Number(parts[2]);
      if (parts.length !== 3 || parts[0] !== connection || !/^[a-f0-9-]{36}$/.test(parts[1]) ||
          !/^\d+$/.test(parts[2]) || !Number.isSafeInteger(seq)) return new Response(null, { status: 400 });
      stream = parts.slice(0, 2).join('.');
    } else {
      const latest = await visible(this.env, agent, ' AND m.created_at >= ? ORDER BY e.seq DESC LIMIT 1', Date.now() - retention);
      seq = latest.results[0]?.seq ?? 0;
    }
    let listener: Listener;
    let timer: ReturnType<typeof setTimeout>;
    const body = new ReadableStream<Uint8Array>({
      start: controller => {
        listener = { connection, expires, stream, seq, controller, pending: Promise.resolve() };
        for (const prior of this.listeners) if (prior.stream === stream) this.close(prior);
        this.listeners.add(listener);
        controller.enqueue(encoder.encode(`id: ${stream}.${seq}\nretry: 1000\ndata:\n\n`));
        timer = setTimeout(() => this.close(listener), Math.max(0, expires - Date.now()));
        this.state.waitUntil(this.queue(agent, listener));
      },
      cancel: () => { clearTimeout(timer); this.listeners.delete(listener); },
    }, { highWaterMark: 128 });
    return new Response(body, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' } });
  }
  private async schedule(agent: string) {
    const due = await this.env.DB.prepare('SELECT MIN(due_at) AS due FROM agent_wakes WHERE agent_id = ? AND due_at IS NOT NULL')
      .bind(agent).first<number>('due');
    if (due !== null) {
      const alarm = await this.state.storage.getAlarm();
      if (alarm === null || alarm > due) await this.state.storage.setAlarm(due);
    }
  }
  async alarm() {
    const agent = await this.state.storage.get<string>('agent');
    if (agent) {
      await deliverOne(this.env, agent);
      await this.schedule(agent);
    }
  }
}
