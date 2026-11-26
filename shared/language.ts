export type Language = 'ja' | 'en';
export type LanguageSetting = Language | 'system';
export const languageCookie = 'a2aroom_language';

export function languageSetting(cookies: string): LanguageSetting {
  const value = cookies.split(';').map(part => part.trim()).find(part => part.startsWith(languageCookie + '='))?.split('=')[1];
  return value === 'ja' || value === 'en' ? value : 'system';
}

export function resolveLanguage(setting: LanguageSetting, preferences: string): Language {
  if (setting !== 'system') return setting;
  const ranked = preferences.toLowerCase().split(',').map(entry => {
    const [tag, weight] = entry.trim().split(/\s*;\s*q=/);
    return { tag: tag.split('-')[0], weight: weight === undefined ? 1 : Number(weight) };
  }).filter(item => item.weight > 0 && item.weight <= 1).sort((a,b) => b.weight - a.weight);
  return ranked.find(item => ['ja','en','*'].includes(item.tag))?.tag === 'ja' ? 'ja' : 'en';
}
