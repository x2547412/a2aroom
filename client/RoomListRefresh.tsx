import { useEffect, useRef, useState } from 'react';
import { ui } from './language';

export function RoomListRefresh({ reload }: { reload: () => Promise<void> }) {
  const action = useRef(reload);
  action.current = reload;
  const [status, setStatus] = useState<'pull' | 'release' | 'loading' | null>(null);

  useEffect(() => {
    const threshold = 72;
    let origin: Touch | undefined;
    let ready = false;
    let loading = false;
    let mounted = true;

    function resetGesture() {
      origin = undefined;
      ready = false;
      document.removeEventListener('touchmove', move);
      if (!loading) setStatus(null);
    }
    function start(event: TouchEvent) {
      resetGesture();
      if (loading || window.scrollY > 0 || event.touches.length !== 1 || document.querySelector('dialog[open]')) return;
      if (event.target instanceof Element && event.target.closest('input,textarea,select,.primary-nav,[role="menu"]')) return;
      origin = event.touches[0];
      document.addEventListener('touchmove', move, {passive:false});
    }
    function move(event: TouchEvent) {
      if (!origin || event.touches.length !== 1) return resetGesture();
      const dy = event.touches[0].clientY - origin.clientY;
      const dx = Math.abs(event.touches[0].clientX - origin.clientX);
      if (dy < 0 || dx > Math.max(8, dy) || window.scrollY > 0) return resetGesture();
      if (dy < 6) { ready = false; setStatus(null); return; }
      if (!event.cancelable) return resetGesture();
      event.preventDefault();
      ready = dy >= threshold;
      setStatus(ready ? 'release' : 'pull');
    }
    function end() {
      const refresh = ready;
      resetGesture();
      if (!refresh) return;
      loading = true;
      setStatus('loading');
      void action.current().finally(() => {
        loading = false;
        if (mounted) setStatus(null);
      });
    }
    document.documentElement.classList.add('room-list-scroll');
    document.addEventListener('touchstart', start, {passive:true});
    document.addEventListener('touchend', end);
    document.addEventListener('touchcancel', resetGesture);
    return () => {
      mounted = false;
      document.documentElement.classList.remove('room-list-scroll');
      document.removeEventListener('touchstart', start);
      document.removeEventListener('touchmove', move);
      document.removeEventListener('touchend', end);
      document.removeEventListener('touchcancel', resetGesture);
    };
  }, []);
  if (!status) return null;
  return <span className="room-list-refresh" role="status">{status === 'pull' ? ui('下に引いて更新','Pull to refresh') :
    status === 'release' ? ui('離して更新','Release to refresh') : ui('更新中…','Refreshing…')}</span>;
}
