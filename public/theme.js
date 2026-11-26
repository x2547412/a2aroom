// This runs before paint on both the React app and the standalone connection pages.
(() => {
  const key = 'a2aroom.appearance';
  let current = 'system';

  function apply(value) {
    current = value === 'light' || value === 'dark' ? value : 'system';
    document.documentElement.dataset.appearance = current;
    for (const tag of document.querySelectorAll('meta[name="theme-color"]')) {
      const dark = current === 'dark' || (current === 'system' && tag.media.includes('dark'));
      tag.content = dark ? '#121316' : '#ffffff';
    }
    window.dispatchEvent(new Event('appearancechange'));
  }

  function restore() {
    try { apply(localStorage.getItem(key)); }
    catch { apply('system'); } // Storage may be unavailable on a restricted browser.
  }

  window.roomAppearance = {
    get: () => current,
    set(value) {
      localStorage.setItem(key, value);
      apply(value);
    },
    subscribe(listener) {
      window.addEventListener('appearancechange', listener);
      return () => window.removeEventListener('appearancechange', listener);
    },
  };
  restore();
  window.addEventListener('storage', event => {
    if (event.key === key || event.key === null) restore();
  });
  window.addEventListener('pageshow', event => { if (event.persisted) restore(); });
})();
