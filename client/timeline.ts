import { timelineCursor, type AgentMembershipEvent } from '../shared/timeline';
import type { Message } from './api';

export type TimelineItem = Message | AgentMembershipEvent;
export type TimelinePage = { moderation_revision: number; items: TimelineItem[]; has_more: boolean };
export const emptyTimeline: TimelinePage = { moderation_revision: 0, items: [], has_more: false };

export function isMessage(item: TimelineItem): item is Message {
  return !('event_order' in item);
}

export function timelinePath(room: string, before?: TimelineItem) {
  const path = '/rooms/' + encodeURIComponent(room) + '/messages?view=timeline';
  return before ? path + '&before=' + timelineCursor(before) : path;
}

export function updateTimeline(previous: TimelinePage, page: TimelinePage): TimelinePage {
  // Preserve older pages only when they connect to the refreshed window.
  const first = page.items[0];
  if (first?.room_id === previous.items[0]?.room_id && page.moderation_revision < previous.moderation_revision) return previous;
  if (page.moderation_revision !== previous.moderation_revision || !first || !page.has_more) return page;
  const overlap = previous.items.findIndex(item => item.room_id === first.room_id && item.id === first.id);
  if (overlap < 1) return page;
  return { ...page, items: [...previous.items.slice(0, overlap), ...page.items], has_more: previous.has_more };
}

export function prependTimeline(previous: TimelinePage, page: TimelinePage, before: TimelineItem): TimelinePage {
  const first = previous.items[0];
  if (page.moderation_revision !== previous.moderation_revision || first?.room_id !== before.room_id || first.id !== before.id) return previous;
  return { ...page, items: [...page.items, ...previous.items], has_more: page.has_more };
}
