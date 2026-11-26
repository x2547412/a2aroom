import { directoryOrigin, isAccountOrigin } from '../shared/directory';
import { languageCookie, languageSetting, resolveLanguage } from '../shared/language';

function readSetting() {
  try { return languageSetting(document.cookie); } catch { return 'system'; }
}

export const setting = readSetting();
export const locale = resolveLanguage(setting, typeof navigator === 'undefined' ? 'ja' : navigator.languages.join(','));
export const ui = (ja: string, en: string) => locale === 'ja' ? ja : en;
export const languageOptions = { system: ui('端末に合わせる', 'Use device language'), ja: '日本語', en: 'English' };

if (typeof window !== 'undefined') {
  document.documentElement.lang = locale;
  const refresh = () => {
    const saved = readSetting();
    if (saved !== setting || resolveLanguage(saved, navigator.languages.join(',')) !== locale) location.reload();
  };
  window.addEventListener('languagechange', refresh);
  window.addEventListener('pageshow', refresh);
}

export function chooseLanguage(next: string) {
  if (!Object.hasOwn(languageOptions, next) || next === setting) return;
  const shared = location.origin === directoryOrigin || isAccountOrigin(location.origin);
  document.cookie = languageCookie + '=' + next + '; Path=/; SameSite=Lax; Max-Age=31536000' +
    (shared ? '; Domain=a2aroom.com' : '') + (location.protocol === 'https:' ? '; Secure' : '');
  if (readSetting() === next) location.reload();
  else window.alert(ui('言語設定の保存には Cookie を許可してください。', 'Allow cookies to save your language preference.'));
}
