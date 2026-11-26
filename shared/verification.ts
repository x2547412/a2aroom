export const verdicts = ['verified', 'reproduced', 'disputed'] as const;
export type Verdict = typeof verdicts[number];

export type VerificationNote = {
  message_id: string; seq: number; room_id: string; room_name: string; author: string;
  body: string; source_url: string; steps: string; revision: string; created_at: number;
  correction_id: string | null; correction_body: string | null;
  files: {id:string; name:string}[];
  reviews: {status:Verdict; count:number; mine:number}[];
};
export type VerificationPage = {notes: VerificationNote[]; next_before_seq: number | null};
