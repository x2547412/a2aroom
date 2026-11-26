import { ScrollItems } from './ScrollPages';
import { ui } from './language';
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Plus } from 'lucide-react';
import { Avatar } from './Avatar';
import { Modal } from './Modal';
import { request, type Agent, type Member } from './api';

type Props = { room: string; agents: Agent[]; members: Member[]; refresh: () => Promise<void> };

export function RoomAgentsButton(props: Props) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className="outline-button compact" aria-haspopup="dialog" onClick={() => setOpen(true)}>
      <Plus size={16} />{ui("エージェントを参加させる", "Add agents to room")} </button>
    {open && createPortal(<RoomAgentsDialog {...props} close={() => setOpen(false)} />, document.body)}
  </>;
}

function RoomAgentsDialog({ room, agents, members, refresh, close }: Props & { close: () => void }) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  async function change(agent: Agent, joined: boolean) {
    setBusy(agent.id); setError('');
    try {
      const path = '/rooms/' + room + '/agents';
      await request(joined ? path + '/' + agent.id : path, { method: joined ? 'DELETE' : 'POST', body: joined ? undefined : { agent_id: agent.id } });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : ui("参加状態を更新できませんでした。", "Could not update membership."));
    } finally { setBusy(''); }
  }
  return <Modal title={ui("エージェントを参加させる", "Add agents to room")} closeDisabled={Boolean(busy)} onClose={close}>
    <div className="member-section">
      {agents.length === 0 && <p className="empty-inline">{ui("エージェント設定から追加できます。", "Add one in agent settings.")}</p>}
      <ScrollItems items={agents}>{agent => {
        const joined = members.some(member => member.agent_id === agent.id);
        return <div className="member-row" key={agent.id}>
          <Avatar name={agent.name} agent subjectId={agent.id} />
          <div><strong>{agent.name}</strong><small>{agent.platform} · @{agent.handle}</small></div>
          <button type="button" className={(joined ? 'secondary-button' : 'outline-button') + ' compact'}
            aria-label={agent.name + (joined ? ui("を退室させる", " (remove from room)") : ui("を参加させる", " (add to room)"))} disabled={Boolean(busy)} onClick={() => void change(agent, joined)}>
            {busy === agent.id ? ui("更新中…", "Updating…") : joined ? ui("退室", "Leave") : ui("参加させる", "Add to room")}
          </button>
        </div>;
      }}</ScrollItems>
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
  </Modal>;
}
