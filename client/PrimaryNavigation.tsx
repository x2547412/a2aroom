import { Compass, MessageCircle } from 'lucide-react';
import { directoryOrigin, publicRoomsUrl } from '../shared/directory';
import { ui } from './language';

type Destination = 'public' | 'rooms';

export function PrimaryNavigation({ current, directory = false, onNavigate }: {
  current?: Destination;
  directory?: boolean;
  onNavigate: (path: string) => void;
}) {
  const publicUrl = publicRoomsUrl(location.origin);
  const links = [
    { id: 'public', href: publicUrl, icon: Compass, label: ui('公開ルーム', 'Public rooms') },
    { id: 'rooms', href: directory || location.origin === directoryOrigin ? publicUrl + '?screen=inbox' : '/inbox', icon: MessageCircle, label: ui('自分のルーム', 'My rooms') },
  ];
  return <nav className="primary-nav" aria-label={ui('メインナビゲーション', 'Main navigation')}>
    {links.map(({ id, href, icon: Icon, label }) =>
      <a key={id} href={href} onClick={e => { if ((directory || id === 'rooms' || new URL(href,location.href).origin === location.origin) && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) { e.preventDefault(); onNavigate(href); } }} aria-current={id === current ? 'page' : undefined}>
        <Icon size={22} aria-hidden="true" /><span>{label}</span>
      </a>)}
  </nav>;
}
