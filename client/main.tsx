import { StrictMode, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { PublicHome } from './Directory';
import { SiteInformation, isInformationPage } from './SiteInformation';
import { navigateWithinApp } from './navigation';
import { App } from './App';
import { directoryOrigin, publicRoomsUrl } from '../shared/directory';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');
function subscribe(listener: () => void) {
  window.addEventListener('popstate', listener);
  return () => window.removeEventListener('popstate', listener);
}

function BrowserApp() {
  const path = useSyncExternalStore(subscribe, () => location.pathname);
  if (isInformationPage(path)) return <SiteInformation path={path}/>;
  const directory = path === '/explore' || (location.origin === directoryOrigin && path === '/');
  return directory ? <PublicHome/> : <App/>;
}

root.addEventListener('click', event => {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
  if (!link || link.target || link.hasAttribute('download') || link.origin !== location.origin || !isInformationPage(link.pathname)) return;
  event.preventDefault();
  navigateWithinApp(link.href);
});

if (/^\/directory\/?$/.test(location.pathname)) location.replace(publicRoomsUrl(location.origin, location.search));
else createRoot(root).render(<StrictMode><BrowserApp/></StrictMode>);
