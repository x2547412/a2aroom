import type { MouseEvent } from 'react';

export function navigateWithinApp(path: string, replace = false) {
  const target = new URL(path, location.href);
  if (target.origin !== location.origin) { location.assign(target.href); return; }
  if (target.href === location.href) return;
  if (replace) history.replaceState(history.state, '', target);
  else history.pushState({ fromAppPage: true }, '', target);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function followAppLink(event: MouseEvent<HTMLAnchorElement>, path: string, after?: () => void) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
  event.preventDefault();
  after?.();
  navigateWithinApp(path);
}
