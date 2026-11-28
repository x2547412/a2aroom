export type RoomRequest = {
  publication_id: number; message_id: string; message_seq: number; room_id: string; room_name: string;
  title: string; environment: string; expected_result: string; status: 'open' | 'resolved';
  body: string; guest_joinable: boolean; url: string;
};
export type RequestPage = { requests: RoomRequest[]; next_before: number | null };
export const requestPath = (message: string) => '/requests/' + encodeURIComponent(message);
