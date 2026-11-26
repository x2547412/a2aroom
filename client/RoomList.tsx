import { ScrollItems } from './ScrollPages';
import { RoomParticipantCounts } from './RoomParticipantCounts';
import { accessLabel } from './RoomAccess';
import { ui } from './language';
import { useEffect, useState } from 'react';
import { MessageCircle, Search, SquarePen, X } from 'lucide-react';
import { Avatar } from './Avatar';
import { dateLabel, type InboxRoom, type Room } from './api';

export function RoomFaces({ room, imageOrigin }: { room: Pick<Room, 'name' | 'portraits'>; imageOrigin?: string }) {
  const people = room.portraits ?? [];
  return <span className={'room-faces' + (people.length > 1 ? ' paired' : '')} aria-hidden="true">
    {people.length ? people.map(person => {
      const agent = person.kind === 'agent';
      const src = imageOrigin && person.image_version != null
        ? `${imageOrigin}/api/images/${agent ? 'agent' : 'user'}/${encodeURIComponent(person.id)}?v=${person.image_version}`
        : undefined;
      return <Avatar key={person.kind + person.id} name={person.name} agent={agent} subjectId={person.id} credentialedSrc={src}/>;
    }) : <Avatar name={room.name} />}
  </span>;
}

type RoomListProps = { rooms: InboxRoom[]; activeId?: string | null; imageOrigin?: string; onOpen: (id: string) => void };

async function roomPage(origin: string, offset: number, query: string, signal?: AbortSignal) {
  const params = new URLSearchParams({offset: String(offset), q: query});
  const response = await fetch(origin + '/api/rooms?' + params, {credentials:'include', cache:'no-store', redirect:'error', signal});
  if (!response.ok) throw new Error(ui('ルームを取得できませんでした。','Could not load rooms.'));
  return ((await response.json()) as {rooms: InboxRoom[]}).rooms;
}

export function RoomRows({ rooms, activeId, onOpen, imageOrigin, query = '' }: RoomListProps & { query?: string }) {
  return <ul className="room-rows"><ScrollItems items={rooms} list loadPage={offset => roomPage(imageOrigin ?? '', offset, query)}>{room => {
    const unread = room.unread_count ?? 0;
    return <li key={room.id}>
      <button type="button" className={'room-row' + (unread ? ' unread' : '')} aria-current={room.id === activeId ? 'page' : undefined} onClick={() => onOpen(room.id)}>
        <RoomFaces room={room} imageOrigin={imageOrigin} />
        <span className="room-row-copy"><strong>{room.name}</strong><span className="room-row-preview">
          <span className="room-preview">{room.last_body || room.description || ui("まだメッセージはありません", "No messages yet")}</span>
          {room.last_message_at != null && <time dateTime={new Date(room.last_message_at).toISOString()}>{dateLabel(room.last_message_at)}</time>}
        </span>
          <span className="room-row-meta"><RoomParticipantCounts room={room}/><span>{accessLabel(room.access_mode)}</span></span>
        </span>
        {unread > 0 && <span className="unread-count" aria-label={ui(`未読${unread}件`, `${unread} unread`)}>{unread > 99 ? '99+' : unread}</span>}
      </button>
    </li>;
  }}</ScrollItems></ul>;
}

export function RoomInbox({ rooms, loaded, onOpen, onCreate, imageOrigin }: RoomListProps & {
  loaded: boolean; onCreate: () => void;
}) {
  const [query, setQuery] = useState('');
  const term = query.trim().normalize('NFKC').toLocaleLowerCase('ja');
  const [result, setResult] = useState<{term: string; rooms: InboxRoom[]}>();
  const [error, setError] = useState('');
  useEffect(() => {
    setError('');
    if (!term) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void roomPage(imageOrigin ?? '', 0, term, controller.signal).then(rows => {
        if (!controller.signal.aborted) setResult({term, rooms:rows});
      }).catch(cause => { if (!controller.signal.aborted) setError(cause.message); });
    }, 180);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [term, imageOrigin, rooms]);
  const matches = term ? result?.term === term ? result.rooms : null : rooms;
  return <section className="settings-page inbox" aria-labelledby="inbox-heading">
    <div className="inbox-tools">
      {rooms.length > 0 && <div className="inbox-search" role="search"><Search size={18} aria-hidden="true" />
      <input type="search" aria-label={ui("参加中のルームを検索", "Search my rooms")} placeholder={ui("ルームを検索", "Search rooms")} value={query} onChange={(event) => setQuery(event.target.value)} />
      {query && <button type="button" aria-label={ui("検索をクリア", "Clear search")} onClick={() => setQuery('')}><X size={16} /></button>}
      </div>}
    </div>
    <header className="page-heading"><h1 id="inbox-heading">{ui("ルーム", "Rooms")}</h1></header>
    {!loaded ? <p className="inbox-status" role="status">{ui("読み込み中…", "Loading…")}</p> : !rooms.length ?
      <div className="inbox-empty"><MessageCircle size={32} strokeWidth={1.4} aria-hidden="true" /><h2>{ui("参加中のルームはありません", "You haven’t joined any rooms yet")}</h2>
        <button type="button" className="primary-button" onClick={onCreate}><SquarePen size={17} />{ui("ルームを作成", "Create room")}</button></div>
      : error ? <p role="alert">{error}</p> : !matches ? <p role="status">{ui('検索中…','Searching…')}</p> : matches.length ? <RoomRows key={term} query={term} rooms={matches} onOpen={onOpen} imageOrigin={imageOrigin} /> : <p className="inbox-status" role="status">{ui("一致するルームはありません", "No matching rooms")}</p>}
  </section>;
}
