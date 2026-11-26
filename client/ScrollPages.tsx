import { useEffect, useRef, useState, type ReactNode } from 'react';
import { pageSize } from '../shared/directory';
import { ui } from './language';

// Remount at each new boundary. A failed request can be retried with the same button.
export function ScrollMore({ load, busy = false, label = ui('続きを表示', 'Load more') }: {
  load: () => void; busy?: boolean; label?: string;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const action = useRef(load);
  action.current = load;
  useEffect(() => {
    if (!button.current || !('IntersectionObserver' in window)) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        observer.disconnect();
        action.current();
      }
    }, { rootMargin: '96px' });
    observer.observe(button.current);
    return () => observer.disconnect();
  }, []);
  return <button ref={button} type="button" className="scroll-more text-button" disabled={busy} onClick={load}>
    {busy ? ui('読み込み中…', 'Loading…') : label}
  </button>;
}

export function ScrollItems<T extends {id?: string | number; blocked_user_id?: string}>({ items, children, loadPage, list = false }: {
  items: T[]; children: (item: T) => ReactNode; loadPage?: (offset: number) => Promise<T[]>; list?: boolean;
}) {
  const [pages, setPages] = useState(1);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [tail, setTail] = useState<T[]>([]);
  const [ended, setEnded] = useState(false);
  const fetchPage = useRef(loadPage);
  fetchPage.current = loadPage;
  const cache = useRef<{head: T[]; rows: T[]; ended: boolean} | null>(null);
  const remote = Boolean(loadPage);

  useEffect(() => {
    const read = fetchPage.current;
    if (!read || pages === 1) return;
    let active = true;
    async function load() {
      const cached = cache.current;
      const sameHead = cached?.head === items;
      const rows = sameHead ? cached.rows.slice() : [];
      let last = items.length < pageSize || (sameHead && cached.ended);
      setBusy(true); setError('');
      try {
        while (items.length + rows.length < pages * pageSize && !last && active) {
          const next = await read!(items.length + rows.length);
          rows.push(...next);
          last = next.length < pageSize;
        }
        if (active) {
          cache.current = {head: items, rows, ended: last};
          setTail(rows); setEnded(last);
        }
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : ui('取得できませんでした。','Could not load.'));
      } finally { if (active) setBusy(false); }
    }
    void load();
    return () => { active = false; };
  }, [items, pages, attempt, remote]);

  const combined = items.concat(tail);
  const rows = remote ? [...new Map(combined.map(item => [item.id ?? item.blocked_user_id, item])).values()] : combined;
  const limit = pages * pageSize;
  const more = remote ? !ended && items.length >= pageSize : rows.length > limit;
  let control: ReactNode;
  if (error) control = <><span role="alert">{error}</span><button type="button" className="scroll-more text-button" onClick={() => setAttempt(value => value + 1)}>{ui('再読み込み','Retry')}</button></>;
  else if (busy || (remote && more && combined.length < limit)) control = <span className="scroll-more" role="status">{ui('読み込み中…','Loading…')}</span>;
  else if (more) control = <ScrollMore key={pages} load={() => setPages(pages + 1)}/>;
  return <>{rows.slice(0, limit).map(children)}{control && (list ? <li>{control}</li> : control)}</>;
}
