import { ScrollItems } from './ScrollPages';
import { ui } from './language';
import { useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight, Search, X } from 'lucide-react';
import { Avatar } from './Avatar';
import { Modal } from './Modal';
import { request, type Member, type Room } from './api';

const previewSize = 3;

function memberName(member: Member) {
  return member.kind === 'agent' ? ui(`${member.account_name}の${member.agent_name}`, `${member.account_name}’s ${member.agent_name}`) : member.display_name || member.account_name;
}

function normalize(text: string) {
  return text.normalize('NFKC').trim().toLocaleLowerCase('ja');
}

export function RoomRoster({ room, members, userId, onChanged, children }: {
  room: Room; members: Member[]; userId: string; onChanged: () => Promise<void>; children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState('');
  const search = useRef<HTMLInputElement>(null);
  const term = normalize(query);
  const words = term.split(/\s+/);
  const matches = open && term ? members.filter(member => {
    const handle = member.handle ? `@${member.account_name}/${member.handle} @${member.handle}` : `@${member.account_name}`;
    const text = normalize([memberName(member), handle, member.platform].join(' '));
    return words.every(word => text.includes(word));
  }) : members;

  async function remove(member: Member) {
    const question = member.kind === 'human'
      ? ui(`${memberName(member)}と所有エージェントをこのルームから追放しますか？ このアカウントは再参加できなくなります。`, `Ban ${memberName(member)} and their agents from this room? This account will be unable to rejoin.`)
      : ui(`${memberName(member)}をルームから退室させますか？`, `Remove ${memberName(member)} from this room?`);
    if (!window.confirm(question)) return;
    setRemoving(true); setError('');
    try {
      await request(`/rooms/${room.id}/members/${member.id}`, { method: 'DELETE' });
      await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : ui("参加者を退室させられませんでした。", "Could not remove the participant.")); }
    finally { setRemoving(false); }
  }

  function row(member: Member) {
    const agent = member.kind === 'agent';
    return <li className="member-row" key={member.id}>
      <Avatar name={memberName(member)} agent={agent} subjectId={member.agent_id ?? member.user_id} />
      <div><strong>{memberName(member)}</strong>
        <small>{agent ? `${member.platform} · @${member.account_name}/${member.handle}` : member.user_id === room.host_user_id ? ui("主催者", "Host") : ui("人間", "People")}</small>
      </div>
      {room.host_user_id === userId && member.user_id !== userId &&
        <button type="button" className="text-button" disabled={removing} aria-label={memberName(member) + (agent ? ui("を退室させる", " (remove from room)") : ui("を追放する", " (remove)"))} onClick={() => void remove(member)}>{agent ? ui("退室", "Leave") : ui("追放", "Remove")}</button>}
    </li>;
  }

  const failure = error && <p className="form-error" role="alert">{error}</p>;
  return <div className="member-section">
    <div className="member-heading"><p className="section-caption">{ui("参加者", "Participants")} <span className="roster-count">{members.length}{ui("人", " people")}</span></p>{children}</div>
    <ul className="roster-rows">{members.slice(0, previewSize).map(row)}</ul>
    <button type="button" className="roster-open" aria-haspopup="dialog" onClick={() => { setQuery(''); setOpen(true); }}>{ui("すべて見る", "View all")}<ChevronRight size={16} aria-hidden="true" />
    </button>
    {!open && failure}
    {open && createPortal(<Modal title={ui("参加者一覧", "All participants")} closeDisabled={removing} onClose={() => setOpen(false)}>
      <div className="roster-directory">
        <div className="inbox-search" role="search"><Search size={18} aria-hidden="true" />
          <input ref={search} type="search" aria-label={ui("参加者を検索", "Search participants")} placeholder={ui("名前・アカウント名で検索", "Search by name or account")} value={query} onChange={e => setQuery(e.target.value)} />
          {query && <button type="button" aria-label={ui("検索をクリア", "Clear search")} onClick={() => { setQuery(''); search.current?.focus(); }}><X size={16} /></button>}
        </div>
        <p className="roster-status" role="status">{term ? (matches.length ? ui(`${members.length}人中 ${matches.length}人`, `${matches.length} of ${members.length}`) : ui("一致する参加者はいません", "No matching participants")) : ui(`${members.length}人`, `Members: ${members.length}`)}</p>
        <ul className={'roster-rows roster-results' + (members.length > 6 ? ' expanded' : '')}><ScrollItems list key={term} items={matches}>{row}</ScrollItems></ul>
        {failure}
      </div>
    </Modal>, document.body)}
  </div>;
}
