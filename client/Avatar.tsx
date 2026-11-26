import { createContext, useContext, useEffect, useState } from 'react';
import { Bot, Monitor } from 'lucide-react';

import defaultUserAvatar from './default-avatar.webp?inline';

export type ImageKind = 'user' | 'agent' | 'platform';
export type ImageVersions = Record<string, number>;
export const ImageContext = createContext<{ images: ImageVersions; refresh: () => Promise<void>; publicRoomId?: string }>({ images: {}, refresh: async () => {} });

export function imageSource(images: ImageVersions, kind: ImageKind, subjectId?: string | null, publicRoomId?: string): string | null {
  if (!subjectId) return null;
  const version = images[`${kind}:${subjectId}`];
  const prefix = publicRoomId ? `/api/public/rooms/${encodeURIComponent(publicRoomId)}` : '/api';
  return version === undefined ? null : `${prefix}/images/${kind}/${encodeURIComponent(subjectId)}?v=${version}`;
}

export function Avatar({ name, agent = false, size = 'normal', subjectId, credentialedSrc }: { name: string; agent?: boolean; size?: 'normal' | 'small' | 'large'; subjectId?: string | null; credentialedSrc?: string }) {
  const { images, publicRoomId } = useContext(ImageContext);
  const src = credentialedSrc ?? imageSource(images, agent ? 'agent' : 'user', subjectId, publicRoomId);
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const hasPhoto = Boolean(src && loadedSrc === src);
  const appearance = !agent && !hasPhoto ? 'avatar-portrait' : `color-${hash % 5}`;
  return <span className={`avatar avatar-${size} ${appearance} ${agent ? 'avatar-agent' : ''}`} aria-hidden="true">
    {!hasPhoto && (agent ? <Bot className="avatar-robot" aria-hidden="true" strokeWidth={2} /> :
      <img src={defaultUserAvatar} alt="" />)}
    {src && <img key={src} crossOrigin={credentialedSrc ? 'use-credentials' : undefined} src={src} alt=""
      style={{ opacity: hasPhoto ? 1 : 0 }} onLoad={() => setLoadedSrc(src)} onError={() => setLoadedSrc(null)} />}
  </span>;
}

export function PlatformIcon({ agentId, fallback = true }: { agentId: string | null; fallback?: boolean }) {
  const { images, publicRoomId } = useContext(ImageContext); const src = imageSource(images, 'platform', agentId, publicRoomId); const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return src && !failed ? <img className="platform-image" src={src} alt="" onError={() => setFailed(true)} /> : fallback ? <Monitor size={16} aria-hidden="true" /> : null;
}
