import { ui } from './language';
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Reply } from 'lucide-react';
import { publicRequest, request, type Message } from './api';

export function SwipeReply({ onReply, children }: { onReply?: () => void; children: ReactNode }) {
  const press = useRef<{ id: number; x: number; y: number; threshold: number; sliding: boolean } | null>(null);
  const blockClick = useRef(false);
  const [distance, setDistance] = useState(0);
  function reset() { press.current = null; setDistance(0); }
  return <div className={'swipe-zone' + (distance ? ' swiping' : '')}
    onPointerDown={e => {
      blockClick.current = false;
      if (!onReply || !e.isPrimary || e.button !== 0 || (e.target as HTMLElement).closest('video,audio,input,.reaction-counts')) return;
      const target = (e.target as Element).closest<HTMLElement>('button,a') ?? e.currentTarget;
      target.setPointerCapture(e.pointerId);
      // A short outgoing bubble may have less than a full swipe left before the screen edge.
      const available = document.documentElement.clientWidth - e.clientX - 2;
      const threshold = Math.max(14, Math.min(52, available * .8));
      press.current = { id: e.pointerId, x: e.clientX, y: e.clientY, threshold, sliding: false };
    }} onPointerMove={e => {
      const p = press.current;
      if (!p || p.id !== e.pointerId) return;
      const dx = e.clientX - p.x, dy = Math.abs(e.clientY - p.y);
      if (!p.sliding) {
        if (Math.max(Math.abs(dx), dy) < 8) return;
        if (dx < 0 || dy > dx * .8) { blockClick.current = true; reset(); return; }
        p.sliding = true; blockClick.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
      }
      setDistance(Math.min(70, Math.max(0, dx)));
    }} onPointerUp={e => {
      const p = press.current;
      if (!p || p.id !== e.pointerId) return;
      const reply = p.sliding && e.clientX - p.x >= p.threshold && Math.abs(e.clientY - p.y) < (e.clientX - p.x) * .8;
      reset();
      if (reply) onReply?.();
    }} onPointerCancel={reset} onLostPointerCapture={e => { if (e.target === e.currentTarget) reset(); }}
    onDragStart={e => { if (press.current) e.preventDefault(); }}
    onClickCapture={e => {
      if (blockClick.current && e.detail !== 0) { e.preventDefault(); e.stopPropagation(); }
      blockClick.current = false;
    }}>
    {distance > 0 && <span className={'swipe-hint' + (distance >= (press.current?.threshold ?? 52) ? ' ready' : '')} aria-hidden="true"><Reply size={18} /></span>}
    <div className="swipe-content" style={distance ? { transform: 'translateX(' + distance + 'px)' } : undefined}>{children}</div>
  </div>;
}

type Seen = { id: string; edited_at: number | null };

// Human receipts acknowledge the displayed revision. Loading a history page or moving the inbox cursor alone is insufficient.
export function useVisibleReads(scroll: RefObject<HTMLDivElement | null>, composer: RefObject<HTMLDivElement | null>,
  messages: Message[], room: string, viewer: string, enabled: boolean, guestCsrf?: string, onRepliesRead?: () => void) {
  const recorded = useRef(new Set<string>());
  const [error, setError] = useState('');
  useEffect(() => {
    const root = scroll.current;
    if (!root || !enabled || !viewer) return;
    const versions = new Map(messages.filter(m => m.author_agent_id || m.author_user_id !== viewer).map(m => [m.id, m.edited_at]));
    const pending = recorded.current;
    const key = (seen: Seen) => viewer + '/' + seen.id + '/' + seen.edited_at;
    let active = true;
    async function acknowledge(batch: Seen[]) {
      const path = '/rooms/' + encodeURIComponent(room) + '/read-receipts';
      for (const item of batch) pending.add(key(item));
      try {
        const options = { method: 'POST', body: { messages: batch } };
        if (guestCsrf) await publicRequest(path, { ...options, csrf: guestCsrf });
        else {
          const result = await request<{ replies_read: boolean }>(path, options);
          if (result.replies_read) onRepliesRead?.();
        }
        if (active) setError('');
      } catch (cause) {
        for (const item of batch) pending.delete(key(item));
        if (active) setError(cause instanceof Error ? cause.message : ui("既読を同期できませんでした。", "Could not sync read receipts."));
      }
    }
    let observer: IntersectionObserver | undefined;
    function observe() {
      observer?.disconnect();
      if (!root || document.visibilityState !== 'visible') return;
      observer = new IntersectionObserver(entries => {
        if (!active || document.visibilityState !== 'visible' || document.querySelector('dialog[open]')) return;
        const batch: Seen[] = [];
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.messageId;
          if (!entry.isIntersecting || !entry.intersectionRect.height || !id || !versions.has(id)) continue;
          const item = { id, edited_at: versions.get(id) ?? null };
          if (!pending.has(key(item))) batch.push(item);
        }
        for (let i = 0; i < batch.length; i += 40) void acknowledge(batch.slice(i, i + 40));
      }, { root, rootMargin: '0px 0px -' + (composer.current?.offsetHeight ?? 0) + 'px 0px' });
      for (const row of root.querySelectorAll<HTMLElement>('[data-message-id]')) {
        if (row.dataset.messageId && versions.has(row.dataset.messageId)) observer.observe(row);
      }
    }
    observe();
    const resize = new ResizeObserver(observe);
    if (composer.current) resize.observe(composer.current);
    document.addEventListener('visibilitychange', observe);
    window.addEventListener('online', observe);
    return () => { active = false; observer?.disconnect(); resize.disconnect(); document.removeEventListener('visibilitychange', observe); window.removeEventListener('online', observe); };
  }, [messages, room, viewer, enabled, guestCsrf, onRepliesRead, scroll, composer]);
  return error;
}
