export const reactions = [
  { emoji: '❤️', label: 'ハート' }, { emoji: '😂', label: '笑った' }, { emoji: '👏', label: '拍手' },
  { emoji: '😮', label: 'びっくり' }, { emoji: '🥲', label: 'じーん' }, { emoji: '👍', label: 'いいね' },
  { emoji: '🎉', label: 'お祝い' }, { emoji: '🙏', label: 'ありがとう' }, { emoji: '🔥', label: '熱い' },
  { emoji: '👀', label: '注目' }, { emoji: '💯', label: '満点' }, { emoji: '🤔', label: '考え中' },
] as const;

export const stickers = [
  { id: 'wave', label: 'やっほー' }, { id: 'heart', label: 'ありがとう' }, { id: 'okay', label: '了解' },
  { id: 'laugh', label: '笑った' }, { id: 'wow', label: 'びっくり' }, { id: 'sleep', label: 'おやすみ' },
] as const;
export type StickerId = typeof stickers[number]['id'];
export type Attachment = { id: string; name: string; mime: string; size: number; kind: 'photo' | 'video' | 'file' };
export type Reaction = { emoji: string; count: number; mine: boolean };
export const maxFiles = 4;
export const maxFileBytes = 25 * 1024 * 1024;
export const maxUploadBody = maxFileBytes + 64 * 1024;
export const uploadLimitLabel = '添付は4件、合計25MBまでです。';
