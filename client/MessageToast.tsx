import { ui } from './language';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { ApiError, request } from './api';
import { Avatar } from './Avatar';

export type IncomingMessage = {
  seq: number; id: string; room_id: string; room_name: string; sender: string; preview: string;
  author_user_id: string; author_agent_id: string | null;
};
type Props = { path?: string; onIncoming: (message: IncomingMessage) => void; onOpen: (message: IncomingMessage) => void };

export function MessageToast({ path = '/inbox', onIncoming, onOpen }: Props) {
  const [message, setMessage] = useState<IncomingMessage | null>(null);
  const receive = useRef(onIncoming);
  useLayoutEffect(() => { receive.current = onIncoming; }, [onIncoming]);
  useEffect(() => {
    let cursor: number | undefined;
    let stopped = false, syncing = false, pending = false;
    let socket: WebSocket | undefined, reconnect: number | undefined;
    let delay = 1000;
    function stop() {
      stopped = true;
      window.clearTimeout(reconnect);
      socket?.close();
    }
    async function sync() {
      if (stopped || document.hidden) return;
      if (syncing) { pending = true; return; }
      syncing = true;
      try {
        do {
          pending = false;
          const query = cursor === undefined ? '' : '?after=' + cursor;
          const { message: latest } = await request<{message: IncomingMessage | null}>(path + '/latest' + query);
          if (stopped) return;
          if (cursor === undefined) cursor = latest?.seq ?? 0;
          else if (latest && latest.seq > cursor && !document.hidden) {
            cursor = latest.seq;
            setMessage(latest);
            receive.current(latest);
          }
        } while (pending && !document.hidden);
      } catch (cause) {
        if (!stopped && cause instanceof ApiError && [401,403,404].includes(cause.status)) {
          stop(); setMessage(null);
        } else if (!stopped) console.warn(ui("新着メッセージを確認できませんでした", "Could not check for new messages"), cause);
      } finally { syncing = false; }
    }
    function connect() {
      if (stopped) return;
      const url = new URL('/api' + path + '/live', location.origin);
      url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(url);
      socket.onopen = () => { delay = 1000; void sync(); };
      socket.onmessage = event => { if (event.data === 'changed') void sync(); };
      socket.onclose = () => {
        if (!stopped) { reconnect = window.setTimeout(connect, delay); delay = Math.min(delay * 2, 30000); }
      };
    }
    void sync();
    connect();
    const timer = window.setInterval(sync, 30000);
    document.addEventListener('visibilitychange', sync);
    window.addEventListener('online', sync);
    return () => {
      stop(); window.clearInterval(timer);
      document.removeEventListener('visibilitychange', sync);
      window.removeEventListener('online', sync);
    };
  }, [path]);
  return message && <Banner key={message.id} message={message} dismiss={() => setMessage(null)}
    open={() => { setMessage(null); onOpen(message); }} />;
}

function Banner({ message, dismiss, open }: { message: IncomingMessage; dismiss: () => void; open: () => void }) {
  const [paused, setPaused] = useState(false);
  const [host, setHost] = useState<Element>(document.body);
  const onDismiss = useRef(dismiss);
  useLayoutEffect(() => { onDismiss.current = dismiss; }, [dismiss]);
  useLayoutEffect(() => {
    // A native modal makes the rest of the page inert. Keep the banner accessible in the active dialog.
    const findHost = () => setHost(Array.from(document.querySelectorAll('dialog[open]')).at(-1) ?? document.body);
    findHost();
    const observer = new MutationObserver(findHost);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'] });
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (paused) return;
    const timer = window.setTimeout(() => onDismiss.current(), 6500);
    return () => window.clearTimeout(timer);
  }, [paused]);
  return createPortal(<div className="message-toast" onPointerEnter={e => { if (e.pointerType === 'mouse') setPaused(true); }}
    onPointerLeave={() => setPaused(false)} onFocus={() => setPaused(true)} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) setPaused(false); }}>
    <button type="button" className="toast-open" onClick={open}>
      <Avatar name={message.sender} subjectId={message.author_agent_id ?? message.author_user_id} agent={Boolean(message.author_agent_id)} size="small" />
      <span role="status"><strong>{message.sender}<small>{message.room_name}</small></strong><span className="toast-preview">{message.preview}</span></span>
    </button>
    <button type="button" className="icon-button" aria-label={ui("新着通知を閉じる", "Dismiss notification")} onClick={dismiss}><X size={16}/></button>
  </div>, host);
}
