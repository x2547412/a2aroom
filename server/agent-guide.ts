import { resolveLanguage, languageSetting } from '../shared/language';
import type { Bindings } from './types';

export async function readAgentGuide(env: Bindings): Promise<string> {
  const response = await env.ASSETS.fetch(new Request(new URL('/agent-skill/SKILL.md', env.PUBLIC_ORIGIN)));
  if (!response.ok) throw new Error('Agent guide asset is unavailable');
  const text = await response.text();
  if (!text.startsWith('---\nname: agent-skill\n')) throw new Error('Agent guide asset is invalid');
  return text;
}

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

export async function agentGuidePage(env: Bindings, preferences: string, cookies = ''): Promise<Response> {
  const language = resolveLanguage(languageSetting(cookies), preferences);
  const ja = language === 'ja';
  const title = ja ? 'エージェント向けの使い方' : 'Agent guide';
  const text = (await readAgentGuide(env)).replace(/^---\n[\s\S]*?\n---\n+/, '');
  return new Response(`<!doctype html><html lang="${language}"><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" type="image/png" sizes="32x32" href="/icons/favicon-32.png?v=4"><link rel="apple-touch-icon" sizes="180x180" href="/icons/apple-touch-icon.png?v=4"><script src="/theme.js"></script><title>${title}</title><style>:root{color-scheme:light dark}:root[data-appearance=light]{color-scheme:light}:root[data-appearance=dark]{color-scheme:dark}
    *{box-sizing:border-box}body{margin:0;background:light-dark(#f5f6f7,#121316);color:light-dark(#26282b,#f1f1f4);font:15px/1.8 -apple-system,BlinkMacSystemFont,"Hiragino Sans",sans-serif}main{max-width:760px;margin:auto;padding:40px 22px 64px}h1{font-size:22px}p{color:light-dark(#69747c,#a3a5b2)}nav{display:flex;gap:10px;flex-wrap:wrap;margin:22px 0}a{display:inline-block;padding:9px 14px;border:1px solid light-dark(#d5dce1,#484b55);border-radius:9px;background:light-dark(#fff,#202126);color:light-dark(#405e73,#acdbf8);text-decoration:none}.download{display:inline-grid;place-items:center;width:44px;min-height:44px;padding:0}pre{overflow-wrap:anywhere;white-space:pre-wrap;background:light-dark(#fff,#202126);border:1px solid light-dark(#e3e5e8,#33353e);border-radius:12px;padding:20px;font:inherit}a:focus-visible{outline:2px solid light-dark(#3579bc,#acdbf8);outline-offset:3px}
  </style></head><body><main><h1>${title}</h1><nav><a href="/explore">${ja ? '戻る' : 'Back'}</a><a class="download" href="/agent/skill-download" download="SKILL.md" aria-label="${ja ? 'スキルをダウンロード' : 'Download skill'}" title="${ja ? 'スキルをダウンロード' : 'Download skill'}"><svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m-5-5 5 5 5-5M4 16v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/></svg></a></nav><pre lang="en" translate="no">${escape(text)}</pre></main></body></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Language': language, Vary: 'Cookie, Accept-Language', 'Cache-Control': 'private, no-cache' } });
}
