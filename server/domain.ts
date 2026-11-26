import { HttpError } from './types';

const usernamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const reserved = new Set(['www', 'app', 'api', 'auth', 'admin', 'mcp', 'mail', 'support', 'staging']);

export function validateAccountName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (name.length < 3 || name.length > 32 || !usernamePattern.test(name) || reserved.has(name)) {
    throw new HttpError(400, 'INVALID_ACCOUNT', 'アカウント名は3〜32文字の英数字とハイフンで入力してください。');
  }
  return name;
}

export function validateText(value: unknown, max: number, label: string, min = 1): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if ([...text].length < min || [...text].length > max) throw new HttpError(400, 'INVALID_TEXT', `${label}は${min}〜${max}文字で入力してください。`);
  return text;
}

export function validTimezone(value: string): boolean {
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(); return true; } catch { return false; }
}

export function validTime(value: string): boolean { return /^([01]\d|2[0-3]):[0-5]\d$/.test(value); }

const timeFormatters = new Map<string, Intl.DateTimeFormat>();
function timeParts(timestamp: number, timezone: string): Record<string, string> {
  let formatter = timeFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    timeFormatters.set(timezone, formatter);
  }
  return Object.fromEntries(formatter.formatToParts(new Date(timestamp)).map((p) => [p.type, p.value]));
}

export function localDate(timestamp: number, timezone: string): string {
  const p = timeParts(timestamp, timezone);
  return `${p.year}-${p.month}-${p.day}`;
}

export function localTime(timestamp: number, timezone: string): string {
  const p = timeParts(timestamp, timezone);
  return `${p.hour}:${p.minute}`;
}

function dateBoundary(low: number, high: number, timezone: string, target: string, next: boolean) {
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    const date = localDate(mid, timezone);
    if (date < target || (next && date === target)) low = mid;
    else high = mid;
  }
  return high;
}

export function dayStart(timestamp: number, timezone: string): number {
  return dateBoundary(timestamp - 48 * 3_600_000, timestamp, timezone, localDate(timestamp, timezone), false);
}

export function nextDayStart(timestamp: number, timezone: string): number {
  return dateBoundary(timestamp, timestamp + 48 * 3_600_000, timezone, localDate(timestamp, timezone), true);
}

export function isQuiet(timestamp: number, timezone: string, start: string | null, end: string | null): boolean {
  if (!start || !end || start === end) return false;
  const parts = timeParts(timestamp, timezone);
  const current = `${parts.hour}:${parts.minute}`;
  return start < end ? current >= start && current < end : current >= start || current < end;
}

export function sensitiveWarnings(body: string, privateCategories: string[]): string[] {
  const rules: Array<[string, RegExp]> = [
    ['address', /〒\s*\d{3}[-ー]?\d{4}|(?:東京都|北海道|(?:大阪|京都)府|.{2,3}県).{1,20}(?:市|区|町|村)/],
    ['finance', /(?:年収|月収|借金|負債)\s*(?:は|が|:|：)?\s*[¥￥\d０-９,.，]+\s*(?:円|万円|億円)?/],
    ['health', /(?:診断名|病名|持病)\s*(?:は|が|:|：)\s*[^\s、。]{2,20}/],
  ];
  return rules.filter(([name, expression]) => privateCategories.includes(name) && expression.test(body)).map(([name]) => name);
}
