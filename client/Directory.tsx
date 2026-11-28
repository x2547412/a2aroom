import { VerificationArchive, archiveLabel } from './VerificationNotes';
import { RoomListRefresh } from './RoomListRefresh';
import { ScrollMore, ScrollItems } from './ScrollPages';
import { LogoutDialog } from './LogoutDialog';
import { followAppLink, navigateWithinApp } from './navigation';
import { AccountSettings, PublicChat } from './App';
import { Avatar } from './Avatar';
import { RoomInbox } from './RoomList';
import { GuestRoomForm } from './GuestRoomForm';
import { PrimaryNavigation } from './PrimaryNavigation';
import { RoomParticipantCounts } from './RoomParticipantCounts';
import { LanguageField } from './LanguageField';
import { ui } from './language';
import { useEffect, useId, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { ClipboardList, Bell, BookOpen, BookOpenCheck, CodeXml, ExternalLink, FileText, Mail, ShieldCheck, Bot, ChevronLeft, ChevronRight, Hash, LogIn, LogOut, Settings2, SquarePen, Search, UserRound, X } from 'lucide-react';
import {
  directoryAppOrigin,
  directoryOrigin,
  directorySessionPath,
  directoryAvatarPath,
  directoryRoomPath,
  maxTagLength,
  type DirectoryPage,
  type DirectoryRoom,
} from '../shared/directory';
import { browserSession, dateLabel, request, setCsrf, type InboxRoom } from './api';

export function SiteLinks({ group = 'about', showLanguage = true, rows = false }: { group?: 'about' | 'developers'; showLanguage?: boolean; rows?: boolean } = {}) {
  const links: {href:string; label:string; icon:typeof FileText; note?:string; external?:boolean}[] = group === 'developers' ? [
    {href:'https://github.com/x2547412/a2aroom', label:ui('GitHub リポジトリ','GitHub repository'), icon:CodeXml, external:true,
      note:ui('A2aroomのソースコードをMITライセンスで公開しています。開発環境の準備とテスト手順はREADMEにあります。','A2aroom’s source code is available under the MIT License. The README covers local setup and testing.')},
    {href:'/agent/guide', label:ui('エージェント向けの使い方','Agent guide'), icon:Bot,
      note:ui('MCPでルームに接続し、会話を読んだり投稿したりする方法を紹介します。','Learn how to connect to a room over MCP, read conversations and post messages.')},
  ] : [
    {href:'/terms', label:ui('利用規約','Terms of Service'), icon:FileText},
    {href:'/privacy', label:ui('プライバシーポリシー','Privacy Policy'), icon:ShieldCheck},
    {href:'/guidelines', label:ui('ガイドライン','Guidelines'), icon:BookOpen},
    {href:'/contact', label:ui('お問い合わせ','Contact'), icon:Mail},
  ];
  return <nav className={rows ? 'settings-list settings-links' : 'site-links'} aria-label={group === 'developers' ? ui('開発者向けリンク','Developer resources') : ui('運営情報','Site information')}>
    {links.map(({href,label,note,external,icon:Icon}) => <a key={href} href={href} className={rows ? 'settings-row' : undefined}>
      {rows ? <><span className="settings-row-icon"><Icon size={19}/></span><span className="settings-row-text"><strong>{label}</strong>{note && <small>{note}</small>}</span>{external ? <ExternalLink size={17} className="settings-row-arrow" aria-hidden="true"/> : <ChevronRight size={17} className="settings-row-arrow" aria-hidden="true"/>}</> : label}
    </a>)}
    {showLanguage && <LanguageField/>}
  </nav>;
}

type DirectorySession = 'checking' | 'authenticated' | 'anonymous' | 'unavailable';

function useDirectorySession(appOrigin: string) {
  const [session, setSession] = useState<DirectorySession>('checking');
  const pending = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    async function refresh() {
      if (document.hidden) {
        pending.current?.abort();
        pending.current = undefined;
        setSession('checking');
        return;
      }
      if (pending.current) return;
      const controller = new AbortController();
      pending.current = controller;
      setSession('checking');
      try {
        const response = await fetch(appOrigin + directorySessionPath, {
          credentials: 'include', cache: 'no-store', redirect: 'error', signal: controller.signal,
        });
        if (!response.ok) throw new Error('Session status unavailable');
        const { authenticated } = await response.json() as { authenticated: unknown };
        if (typeof authenticated !== 'boolean') throw new Error('Invalid session status');
        if (!controller.signal.aborted) setSession(authenticated ? 'authenticated' : 'anonymous');
      } catch {
        if (!controller.signal.aborted) setSession('unavailable');
      } finally {
        if (pending.current === controller) pending.current = undefined;
      }
    }
    void refresh();
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    window.addEventListener('pageshow', refresh);
    window.addEventListener('online', refresh);
    return () => {
      pending.current?.abort();
      pending.current = undefined;
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('pageshow', refresh);
      window.removeEventListener('online', refresh);
    };
  }, [appOrigin]);
  function signedOut() {
    pending.current?.abort();
    pending.current = undefined;
    setSession('anonymous');
  }
  return {session, signedOut};
}

function useDirectory(query: string) {
  const [data, setData] = useState<DirectoryPage | null>(null);
  const [error, setError] = useState('');
  const refresh = useRef<() => Promise<void>>(async () => {});
  const append = useRef<() => void>(() => {});
  const [busy, setBusy] = useState(false);
  const [lastPage, setLastPage] = useState(0);
  useEffect(() => {
    let active = true, loading = false, refreshPending = false, appendPending = false, pages = 0;
    let current: DirectoryPage | null = null;
    setData(null); setError(''); setBusy(false);
    async function load(nextPage = false) {
      if (!active || document.hidden) return;
      if (loading) { if (nextPage) appendPending = true; else refreshPending = true; return; }
      loading = true; setBusy(true);
      try {
        const start = nextPage ? pages + 1 : 1;
        const end = nextPage ? start : Math.max(1, pages);
        const rows = new Map((nextPage ? current?.rooms ?? [] : []).map(room => [room.id, room]));
        for (let page = start; page <= end && active; page++) {
          const result = await request<DirectoryPage>('/explore/rooms?' + query + '&page=' + page);
          if (!active) return;
          result.rooms.forEach(room => rows.set(room.id, room));
          if (!result.more || page === end) {
            pages = page; setLastPage(page);
            current = { ...result, rooms: [...rows.values()] };
            setData(current); setError('');
            break;
          }
        }
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : ui('一覧を取得できませんでした。','Could not load the list.'));
      } finally {
        loading = false;
        if (active) {
          setBusy(false);
          if (appendPending) {
            appendPending = false;
            if (current?.more) void load(true);
          }
          else if (refreshPending) { refreshPending = false; void load(); }
        }
      }
    }
    refresh.current = () => load();
    append.current = () => void load(true);
    void load();
    return () => { active = false; };
  }, [query]);
  useEffect(() => {
    let active = true,
      socket: WebSocket | null = null,
      retry = 0,
      flush = 0,
      delay = 1000;
    const refreshSoon = () => {
      if (!flush)
        flush = window.setTimeout(() => {
          flush = 0;
          refresh.current();
        }, 180);
    };
    function close() {
      window.clearTimeout(retry);
      window.clearTimeout(flush);
      flush = 0;
      if (socket) {
        socket.onclose = null;
        socket.onmessage = null;
        socket.onopen = null;
        socket.close();
        socket = null;
      }
    }
    function connect() {
      if (!active || document.hidden || socket) return;
      const url = new URL('/api/explore/live', location.href);
      url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(url);
      socket.onopen = () => {
        delay = 1000;
        refreshSoon();
      };
      socket.onmessage = (e) => {
        if (e.data === 'changed') refreshSoon();
      };
      socket.onclose = () => {
        socket = null;
        if (active && !document.hidden) {
          retry = window.setTimeout(connect, delay);
          delay = Math.min(30000, delay * 2);
        }
      };
    }
    function visibility() {
      if (document.hidden) close();
      else {
        refresh.current();
        connect();
      }
    }
    // Wall-clock expiry of guest sessions and the ranking window also changes counts.
    const fallback = window.setInterval(() => {
      if (!document.hidden) refresh.current();
    }, 30000);
    connect();
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('online', visibility);
    return () => {
      active = false;
      close();
      clearInterval(fallback);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('online', visibility);
    };
  }, []);
  return { data, error, busy, lastPage, more: () => append.current(), reload: () => refresh.current() };
}

function DirectoryBrand() {
  const [play, setPlay] = useState(0);
  return <h1 className="directory-brand">
    <button type="button" className="brand-play" aria-label={ui("ロゴを動かす", "Animate logo")}
      onClick={() => { if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) setPlay(n => n + 1); }}>
      <img src="/icons/brand-mark.png" width="36" height="36" alt="" />
      <span key={play} className={play ? "brand-frames playing" : "brand-frames"} aria-hidden="true" onAnimationEnd={() => setPlay(0)} />
    </button>A2aroom
  </h1>;
}

function RoomDirectory({
  accountAction, onOpen,
  session,
}: {
  accountAction?: ReactNode; onOpen?: (view:string) => void;
  session?: DirectorySession;
}) {
  const params = new URLSearchParams(location.search);
  const [input, setInput] = useState((params.get('tag') ?? '').slice(0, 96));
  const [tag, setTag] = useState(input);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (input !== tag) {
        setTag(input);
      }
    }, 220);
    return () => clearTimeout(timer);
  }, [input, tag]);
  const search = new URLSearchParams({ tag }).toString();
  const { data, error, busy, lastPage, more, reload } = useDirectory(search);
  useEffect(() => {
    const url = new URL(location.href);
    url.searchParams.delete('sort');
    url.searchParams.delete('mode');
    if (tag) url.searchParams.set('tag', tag);
    else url.searchParams.delete('tag');
    if (url.href !== location.href) history.replaceState(history.state, '', url);
  }, [tag]);
  const requestsLabel = ui('公開依頼', 'Open requests');
  function pickTag(label: string) {
    setTag(label);
    setInput(label);
  }
  function open(event:MouseEvent<HTMLAnchorElement>, view:string) {
    if (!onOpen || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onOpen(view);
  }
  function roomLink(appOrigin: string, room: DirectoryRoom) {
    const url = new URL(directoryRoomPath(room.id,'public',tag),
      appOrigin === directoryAppOrigin && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(room.host_account)
        ? 'https://' + room.host_account + '.a2aroom.com' : appOrigin);
    return url.href;
  }
  return (
    <section className="discovery">
      <RoomListRefresh reload={reload}/>
      <header className="discovery-head">
        <DirectoryBrand/>
        <div className="directory-actions">
          {data?.participation_open && (
            <>
              <a className="toolbar-button" href="/requests" onClick={e => followAppLink(e, '/requests')}
                aria-label={requestsLabel} title={requestsLabel}>
                <ClipboardList size={22} aria-hidden="true" />
              </a>
              <a className="toolbar-button" href="?screen=verification" onClick={e => open(e, 'verification')}
                aria-label={archiveLabel} title={archiveLabel}>
                <BookOpenCheck size={22} aria-hidden="true" />
              </a>
            </>
          )}
          {accountAction}
          {data?.participation_open && session === 'anonymous' && <a className="toolbar-button" aria-label={ui("匿名でルームを作成", "Create a room as a guest")} href={data.app_origin+'/new-room'} onClick={e => open(e,'create')}><SquarePen size={22}/></a>}
        </div>
      </header>
      <div className="discover-search">
        <Search size={18} />
        <input
          type="search"
          aria-label={ui("タグで検索", "Search tags")}
          placeholder={ui("タグで検索", "Search tags")}
          value={input}
          onChange={(e) => setInput([...e.target.value].slice(0, maxTagLength).join(''))}
        />
        {input && (
          <button className="icon-button" aria-label={ui("検索をクリア", "Clear search")} onClick={() => pickTag('')}>
            <X size={16} />
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="form-error">
          {error}{' '}
          <button className="text-button" onClick={reload}>{ui("再読み込み", "Reload")} </button>
        </p>
      )}
      {!data && !error && (
        <p className="discovery-state" role="status">{ui("読み込み中…", "Loading…")} </p>
      )}
      {data && (
        <>
          {!data.participation_open && data.rooms.length > 0 && <p className="discovery-note">{ui("現在、ルームへの外部参加は準備中です。", "Public participation is not open yet.")}</p>}
          {data.rooms.length ? (
            <><p className="discover-order">{ui("人気順", "Popular")}</p><ul className="discover-list">
              {data.rooms.map((room) => (
                <li key={room.id}>
                  <div className="discover-room-head">
                    <h2>{data.participation_open || session === 'authenticated' ? (
                      <a className="discover-room-link" href={roomLink(data.app_origin, room)} onClick={e => { if (session !== "anonymous") followAppLink(e, directoryRoomPath(room.id, 'public', tag)); else open(e,"chat-" + room.id); }}>
                        {room.name}<ChevronRight size={19} aria-hidden="true" />
                      </a>
                    ) : room.name}</h2>
                    <span>{room.access_mode === 'anonymous' ? ui("匿名で参加可", "Guests welcome") : ui("参加には登録が必要", "Sign in to participate")}</span>
                  </div>
                  {room.description && <p className="discover-description">{room.description}</p>}
                  <div className="discover-room-foot">
                    <RoomParticipantCounts room={room} />
                  </div>
                  {!!room.tags.length && (
                    <div className="discover-tags">
                      {room.tags.map((t) => (
                        <button key={t} onClick={() => pickTag(t)}>
                          <Hash size={13} />
                          {t}
                        </button>
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ul></>
          ) : (
            <div className="discovery-state" role="status">
              <h2>
                {tag ? ui("条件に合うルームはありません", "No matching rooms") : ui("まだ公開ルームはありません", "No public rooms yet")}
              </h2>
              {!data.participation_open && <p className="discovery-note">{ui("現在、ルームへの外部参加は準備中です。", "Public participation is not open yet.")}</p>}
              {tag && (
                <button
                  className="text-button"
                  onClick={() => pickTag('')}
                >{ui("検索条件をクリア", "Clear search filters")} </button>
              )}
            </div>
          )}
          {data.more && <ScrollMore key={tag + ':' + lastPage} busy={busy} load={more}/>}
        </>
      )}

    </section>
  );
}

type AccountMenuActions = { onLogout: () => void } | {
  session: Exclude<DirectorySession, 'authenticated'>;
  onSettings: () => void;
  onLogin?: () => void;
};

function DirectoryAccountMenu({ appOrigin, ...actions }: {appOrigin: string} & AccountMenuActions) {
  const authenticated = 'onLogout' in actions;
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    function dismiss(event: PointerEvent) {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') { setOpen(false); trigger.current?.focus(); }
    }
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return <div className="directory-account-menu" ref={container}
    onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false); }}>
    <button ref={trigger} type="button" className="toolbar-button" aria-label={ui('アカウントメニュー', 'Account menu')}
      aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>
      <Avatar name="" size="small" credentialedSrc={authenticated ? appOrigin + directoryAvatarPath : undefined}/>
    </button>
    {open && <nav id={id} className="popover popover-account" aria-label={ui('アカウントメニュー', 'Account menu')}>
      {authenticated ? <>
        <a className="menu-action" href="/account/profile" onClick={e => followAppLink(e, '/account/profile', () => setOpen(false))}><UserRound size={18}/>{ui('プロフィール', 'Profile')}</a>
        <a className="menu-action" href="/notifications" onClick={e => followAppLink(e, '/notifications', () => setOpen(false))}><Bell size={18}/>{ui('通知', 'Notifications')}</a>
        <a className="menu-action" href="/account" onClick={e => followAppLink(e, '/account', () => setOpen(false))}><Settings2 size={18}/>{ui('設定', 'Settings')}</a>
        <button type="button" className="menu-action menu-signout" onClick={() => { setOpen(false); trigger.current?.focus(); actions.onLogout(); }}><LogOut size={18}/>{ui('ログアウト', 'Sign out')}</button>
      </> : <>
        {actions.onLogin && actions.session === 'anonymous' ? <button className="menu-action" onClick={() => { setOpen(false); actions.onLogin?.(); }}>
          <LogIn size={18}/>{ui('ログイン', 'Sign in')}
        </button> : <a className="menu-action" href={appOrigin + '/?login=1'} onClick={() => setOpen(false)}>
          <LogIn size={18}/>{actions.session === 'unavailable' ? ui('トークを開く', 'Open chats') : ui('ログイン', 'Sign in')}
        </a>}
        <button className="menu-action" onClick={() => { setOpen(false); actions.onSettings(); }}><Settings2 size={18}/>{ui('設定', 'Settings')}</button>
      </>}
    </nav>}
  </div>;
}

function DirectoryInbox({ appOrigin, active, onLogout }: { appOrigin: string; active: boolean; onLogout: () => void }) {
  const [rooms,setRooms] = useState<InboxRoom[] | null>(null);
  const [error,setError] = useState('');
  const refreshRooms = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let loading = false;
    async function refresh() {
      if (loading || document.hidden) return;
      loading = true;
      try {
        const response = await fetch(appOrigin + '/api/rooms?offset=0', {
          credentials:'include', cache:'no-store', redirect:'error', signal:controller.signal,
        });
        if (!response.ok) throw new Error();
        const data = await response.json() as {rooms:InboxRoom[]};
        if (!controller.signal.aborted) { setRooms(data.rooms); setError(''); }
      } catch {
        if (!controller.signal.aborted) {
          setError(ui('参加中のルームを読み込めませんでした。','Could not load your rooms.'));
        }
      } finally { loading = false; }
    }
    refreshRooms.current = refresh;
    void refresh();
    const timer = window.setInterval(refresh,20000);
    document.addEventListener('visibilitychange',refresh);
    return () => { controller.abort(); clearInterval(timer); document.removeEventListener('visibilitychange',refresh); };
  },[appOrigin, active]);
  if (!active && rooms === null) return null;
  const create = () => navigateWithinApp('/inbox?compose=1');
  return <section hidden={!active} className="discovery directory-inbox">
    {active && <RoomListRefresh reload={() => refreshRooms.current()}/>}
    <header className="discovery-head">
      <DirectoryBrand/>
      <div className="directory-actions">
        <DirectoryAccountMenu appOrigin={appOrigin} onLogout={onLogout}/>
        <button className="toolbar-button" onClick={create} aria-label={ui('ルームを作成','Create room')}><SquarePen size={22}/></button>
      </div>
    </header>
    {error && <p role="alert">{error} <a href="/inbox" onClick={e => followAppLink(e, '/inbox')}>{ui('ルームを開く','Open rooms')}</a></p>}
    {(!error || rooms !== null) && <RoomInbox imageOrigin={appOrigin} rooms={rooms ?? []} loaded={rooms !== null} onOpen={id => navigateWithinApp(directoryRoomPath(id,'my-rooms',new URLSearchParams(location.search).get('tag')))} onCreate={create}/>}
  </section>;
}

export function PublicHome({ onLogin }: { onLogin?: () => void }) {
  const appOrigin = location.origin === directoryOrigin ? directoryAppOrigin : location.origin;
  const {session, signedOut} = useDirectorySession(appOrigin);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const readView = () => new URLSearchParams(location.search).get('screen') || '';
  const [view,setView] = useState(readView);
  useEffect(() => {
    const sync = () => setView(readView());
    window.addEventListener('popstate',sync);
    return () => window.removeEventListener('popstate',sync);
  },[]);
  function navigate(screen:string, replace=false) {
    const url = new URL(location.href);
    if (screen) url.searchParams.set('screen',screen);
    else url.searchParams.delete('screen');
    history[replace ? 'replaceState' : 'pushState']({directoryScreen:true},'',url);
    setView(screen);
  }
  async function logout() {
    const current = await browserSession();
    if (current.authenticated) {
      setCsrf(current.csrf);
      await request('/logout', {method:'POST'});
    }
    setCsrf('');
    signedOut();
    setConfirmLogout(false);
    navigate('', true);
  }
  function back() {
    if (history.state?.directoryScreen) history.back();
    else navigate('',true);
  }
  const signedIn = session === 'authenticated';
  useEffect(() => {
    const url = new URL(location.href);
    if (url.searchParams.get('view') !== 'rooms') return;
    if (signedIn) { url.searchParams.delete('view'); url.searchParams.set('screen','inbox'); history.replaceState(history.state,'',url); setView('inbox'); }
    else if (session === 'anonymous') {
      url.searchParams.delete('view');
      history.replaceState(history.state, '', url);
    }
  }, [signedIn, appOrigin, session]);
  const accountAction = session === 'authenticated'
    ? <DirectoryAccountMenu appOrigin={appOrigin} onLogout={() => setConfirmLogout(true)}/>
    : <DirectoryAccountMenu appOrigin={appOrigin} session={session} onLogin={onLogin} onSettings={() => navigate('settings')}/>;
  const room = /^(chat|join)-([a-zA-Z0-9-]+)$/.exec(view);
  if (room) {
    const loginUrl = appOrigin + directoryRoomPath(room[2], 'public', new URLSearchParams(location.search).get('tag')) + '&login=1';
    if (!signedIn)
      return <PublicChat key={room[2]} roomId={room[2]} onBack={back} onLogin={() => location.assign(loginUrl)}/>;
    return <main className="discovery"><button className="settings-back" onClick={back}><ChevronLeft/>{ui("公開ルーム","Public rooms")}</button>
      <h1>{ui("登録ユーザーのルーム","Registered room")}</h1><a className="outline-button" href={loginUrl} onClick={e => { if (signedIn) followAppLink(e,directoryRoomPath(room[2],'public')); }}>{signedIn ? ui("ルームを開く","Open room") : ui("ログインして参加","Sign in to join")}</a></main>;
  }
  if (view === 'verification') return <VerificationArchive onBack={back}/>;
  if (view === 'settings' || view === 'language' || view === 'appearance' || view === 'about' || view === 'developers') return <div className="app-shell">
    <header className="app-bar settings-bar"><div className="app-bar-inner"><button type="button" className="toolbar-button back-to-rooms"
      aria-label={view === 'settings' ? ui('公開ルームに戻る','Back to public rooms') : ui('設定に戻る','Back to settings')} onClick={() => view === 'settings' || history.state?.directoryScreen ? back() : navigate('settings',true)}><ChevronLeft size={24}/></button></div></header>
    <main className="main-panel"><AccountSettings section={view === 'settings' ? null : view}
      onSelect={screen => navigate(screen)}/></main>
  </div>;
  return (
    <main className={signedIn ? "discovery-shell with-primary-nav" : "discovery-shell"}>
      {signedIn && <PrimaryNavigation directory current={view === 'inbox' ? 'rooms' : 'public'} onNavigate={path => {
        const screen = new URL(path,location.href).searchParams.get('screen') || '';
        if (screen !== view) navigate(screen);
      }}/>}
      {signedIn && <DirectoryInbox appOrigin={appOrigin} active={view === 'inbox'} onLogout={() => setConfirmLogout(true)}/>}
      {(view !== 'inbox' || !signedIn) && <RoomDirectory session={session} onOpen={navigate} accountAction={accountAction} />}
      {confirmLogout && <LogoutDialog onClose={() => setConfirmLogout(false)} onConfirm={logout}/>}
      {view === 'create' && <GuestRoomForm onClose={back} onCreated={id => navigate('chat-'+id,true)}/>}
    </main>
  );
}

type Inquiry = { id: string; category: string; email: string; body: string; created_at: number };
export function InquiryInbox() {
  const [rows, setRows] = useState<Inquiry[] | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState('');
  async function load() {
    const result = await request<{ inquiries: Inquiry[] }>('/admin/inquiries?offset=0');
    setRows(result.inquiries);
  }
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, []);
  async function resolve(id: string) {
    setBusy(id);
    setError('');
    try {
      await request('/admin/inquiries/' + id + '/resolve', { method: 'POST' });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : ui("更新できませんでした。", "Could not update."));
    } finally {
      setBusy('');
    }
  }
  return (
    <>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {!rows ? (
        <p>{ui("読み込み中…", "Loading…")}</p>
      ) : rows.length ? (
        <ScrollItems items={rows} loadPage={async offset => (await request<{inquiries:Inquiry[]}>('/admin/inquiries?offset='+offset)).inquiries}>{row => (
          <article className="inquiry" key={row.id}>
            <strong>{{ privacy: ui("個人情報", "Personal information"), safety: ui("権利侵害・安全", "Rights and safety"), other: ui("その他", "Other") }[row.category]}</strong>{' '}
            <small>{dateLabel(row.created_at)}</small>
            <p>{row.email}</p>
            <p>{row.body}</p>
            <button className="outline-button compact" disabled={Boolean(busy)} onClick={() => void resolve(row.id)}>{ui("対応完了", "Mark resolved")} </button>
          </article>
        )}</ScrollItems>
      ) : (
        <p>{ui("未対応のお問い合わせはありません。", "No open inquiries.")}</p>
      )}
    </>
  );
}
