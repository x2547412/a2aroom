export const socialNames = {
  instagram: 'Instagram', tiktok: 'TikTok', threads: 'Threads', x: 'X', bereal: 'BeReal', setlog: 'Setlog',
} as const;
export type SocialService = keyof typeof socialNames;
export type SocialLinks = Partial<Record<SocialService, string>>;
export const socialServices = Object.keys(socialNames) as SocialService[];

const hosts: Record<SocialService, string[]> = {
  instagram: ['instagram.com'], tiktok: ['tiktok.com'], threads: ['threads.com', 'threads.net'],
  x: ['x.com', 'twitter.com'], bereal: ['bere.al', 'bereal.com'], setlog: ['setlog.kr', 'setlog.app'],
};

export function socialUrl(service: SocialService, value: string): string | null {
  if (value.length > 2048) return null;
  let url: URL;
  try { url = new URL(value.trim()); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !hosts[service].includes(url.hostname.replace(/^www\./, ''))) return null;
  if (service === 'setlog') {
    if (!/^\/invite(?:\/[^/]+\/?)?$/.test(url.pathname) || (url.pathname === '/invite' && !url.search)) return null;
  } else {
    const path = service === 'tiktok' || service === 'threads' ? /^\/@[\w.-]+\/?$/ : /^\/[\w.-]+\/?$/;
    if (!path.test(url.pathname)) return null;
    url.search = '';
  }
  url.hash = '';
  return url.href;
}
