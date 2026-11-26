import { ui } from './language';
import { useEffect, useRef, useState } from 'react';
import { publicRequest, request } from './api';

type Person = { id: string; name: string; remaining_ms: number };

export function useReplyStatus(room: string, guest: boolean, refreshHistory: () => void) {
  const [agents, setAgents] = useState<(Person & {agent:boolean})[]>([]);
  const refresh = useRef(refreshHistory);
  refresh.current = refreshHistory;
  useEffect(() => {
    let stopped = false;
    let busy = false;
    let previous = new Set<string>();
    let expiry: number;
    async function poll() {
      if (busy || document.hidden) return;
      busy = true;
      const started = performance.now();
      try {
        const data = await (guest ? publicRequest : request)<{ agents: Person[]; humans?: Person[] }>(`/rooms/${encodeURIComponent(room)}/reply-status`);
        if (stopped) return;
        const current = new Set(data.agents.map(agent => agent.id));
        if ([...previous].some(id => !current.has(id))) refresh.current();
        previous = current;
        window.clearTimeout(expiry);
        function render() {
          const elapsed = performance.now() - started;
          const active = [...data.agents.map(p=>({...p,agent:true})), ...(data.humans ?? []).map(p=>({...p,agent:false}))].filter(agent => agent.remaining_ms > elapsed);
          setAgents(active);
          if (active.length) expiry = window.setTimeout(render, Math.ceil(Math.min(...active.map(agent => agent.remaining_ms)) - elapsed));
        }
        render();
      } catch (error) {
        if (!stopped) { setAgents([]); window.clearTimeout(expiry); console.warn(ui("返信状態を取得できませんでした", "Could not load reply status"), error); }
      } finally { busy = false; }
    }
    void poll();
    const timer = window.setInterval(poll, 2500);
    document.addEventListener('visibilitychange', poll);
    return () => { stopped = true; window.clearInterval(timer); window.clearTimeout(expiry); document.removeEventListener('visibilitychange', poll); };
  }, [room, guest]);
  return agents;
}

export function useComposerPresence(room: string, enabled: boolean, guestCsrf?: string) {
  const [focused, setFocused] = useState(false);
  const queue = useRef(Promise.resolve());
  useEffect(() => {
    if (!enabled || !focused) return;
    let active = false;
    const path = '/rooms/' + encodeURIComponent(room) + '/reply-status';
    function publish(value: boolean) {
      active = value;
      queue.current = queue.current.then(async () => {
        const options = {method:'PUT',body:{active:value}};
        if (guestCsrf) await publicRequest(path,{...options,csrf:guestCsrf});
        else await request(path,options);
      }).catch(error => console.warn(ui("入力状態を更新できませんでした", "Could not update typing status"),error));
    }
    function sync() {
      const visible = !document.hidden && document.hasFocus();
      if (visible !== active) publish(visible);
    }
    sync();
    const timer = window.setInterval(() => { if (active) publish(true); }, 12_000);
    document.addEventListener('visibilitychange',sync);
    window.addEventListener('focus',sync);
    window.addEventListener('blur',sync);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange',sync);
      window.removeEventListener('focus',sync);
      window.removeEventListener('blur',sync);
      if (active) publish(false);
    };
  },[room,enabled,focused,guestCsrf]);
  return setFocused;
}
