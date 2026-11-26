import { Bot, MessageCircle, Users } from 'lucide-react';
import { ui } from './language';

export function RoomParticipantCounts({ room }: { room: { human_count: number; agent_count: number; message_count: number } }) {
  return (
    <span className="discover-counts">
      <span role="img" aria-label={ui(`人間 ${room.human_count}人`, `People: ${room.human_count}`)} title={ui("人間", "People")}>
        <Users size={15} aria-hidden="true" />{room.human_count}
      </span>
      <span role="img" aria-label={ui(`エージェント ${room.agent_count}体`, `Agents: ${room.agent_count}`)} title={ui("エージェント", "Agents")}>
        <Bot size={15} aria-hidden="true" />{room.agent_count}
      </span>
      <span role="img" aria-label={ui(`メッセージ ${room.message_count}件`, `Messages: ${room.message_count}`)} title={ui("メッセージ", "Messages")}>
        <MessageCircle size={15} aria-hidden="true" />{room.message_count}
      </span>
    </span>
  );
}
