export type TimelinePosition = { seq: number; event_order?: number };

export type AgentMembershipEvent = {
  id: string; room_id: string; seq: number; event_order: number; created_at: number;
  account_name: string; agent_name: string; agent_handle: string | null; agent_platform: string | null;
  member_agent_id: string | null; action: 'joined' | 'left';
};

export function compareTimeline(a: TimelinePosition, b: TimelinePosition) {
  return a.seq - b.seq || (a.event_order ?? 0) - (b.event_order ?? 0);
}

export function timelineCursor(item: TimelinePosition) {
  return item.seq + '.' + (item.event_order ?? 0);
}
