import { SocialIcons } from './SocialLinks';
import type { SocialLinks } from '../shared/social-links';
import { locale, ui } from './language';
import { useEffect, useState } from 'react';
import { directoryOrigin, isAccountOrigin } from '../shared/directory';
import { EditableName } from './EditableName';
import { Avatar } from './Avatar';
import { Modal } from './Modal';
import type { AgentMembershipEvent } from '../shared/timeline';
import { ApiError, publicRequest, request } from './api';

export type ProfileRef = { kind: 'agent' | 'human'; id: string };
type Profile = { social_links?: SocialLinks; kind: 'agent' | 'human'; name: string; account_name: string; is_guest: number; handle: string | null; platform: string | null; bio: string | null; can_rename: number };

export function profileFromLocation(room: string): ProfileRef | null {
  const [, rooms, id, profiles, kind, subject] = location.pathname.split('/');
  return rooms === 'rooms' && id === room && profiles === 'profiles' && (kind === 'agent' || kind === 'human') && subject
    ? { kind, id: subject } : null;
}

export function EditableAgentName({ id, name, onSaved }: { id: string; name: string; onSaved: (name: string) => void }) {
  return <EditableName name={name} onSave={async next => {
    await request('/agents/' + encodeURIComponent(id), { method: 'PATCH', body: { name: next } });
    onSaved(next);
  }} />;
}

type ProfileTarget = { subject: ProfileRef; event?: never } | { subject?: never; event: AgentMembershipEvent };

export function ParticipantProfile({ room, subject, event, publicView, onClose, onRename }: ProfileTarget & {
  room: string; publicView: boolean; onClose: () => void; onRename?: (id: string, name: string) => void;
}) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState('');
  const kind = subject?.kind ?? 'agent';
  const id = subject?.id ?? event?.member_agent_id;
  const fromEvent = Boolean(event);
  useEffect(() => {
    if (!id) return;
    let active = true;
    const path = '/rooms/' + encodeURIComponent(room) + '/profiles/' + kind + '/' + encodeURIComponent(id);
    const load = publicView ? publicRequest : request;
    void load<Profile>(path).then(data => { if (active) setProfile(data); })
      .catch(cause => {
        // Membership may end between opening the timeline and opening the dialog.
        if (!active || (fromEvent && cause instanceof ApiError && cause.status === 404)) return;
        setError(cause instanceof Error ? cause.message : ui("プロフィールを開けませんでした。", "Could not open the profile."));
      });
    return () => { active = false; };
  }, [room, kind, id, publicView, fromEvent]);

  const shown = profile ?? (event && {
    name: event.agent_name, account_name: event.account_name, handle: event.agent_handle,
    platform: event.agent_platform, is_guest: false, bio: null,
  });
  const publicUrl = profile?.kind === 'human' && !profile.is_guest && (location.origin === directoryOrigin || isAccountOrigin(location.origin)) &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(profile.account_name)
    ? 'https://' + profile.account_name + '.a2aroom.com/' : null;
  const identity = shown && <>
    <Avatar size="large" agent={kind === 'agent'} subjectId={profile ? id : null} name={shown.name} />
    {!event && profile?.can_rename && id ? <EditableAgentName id={id} name={profile.name} onSaved={name => { setProfile({ ...profile, name }); onRename?.(id, name); }} /> : <h1>{shown.name}</h1>}
    {!shown.is_guest && <p className="participant-handle">{event && !shown.handle && ui("持ち主", "Owner")}@{shown.account_name}{shown.handle && '/' + shown.handle}</p>}
  </>;
  return <Modal title={event ? ui("エージェントの詳細", "Agent details") : ui("プロフィール", "Profile")} onClose={onClose}>
    <div className="participant-profile">
      {shown && <>
        {publicUrl ? <a className="participant-public-link" referrerPolicy="origin" href={publicUrl} aria-label={shown.name + ui("の公開プロフィールを見る", "’s public profile")}>{identity}</a> : identity}
        {shown.platform && <p>{shown.account_name}{ui("のエージェント ·", "’s agent · ")} {shown.platform}</p>}
        {shown.bio && <p className="participant-bio">{shown.bio}</p>}
        {profile?.social_links && <SocialIcons links={profile.social_links} />}
      </>}
      {event && <p className="membership-date"><time dateTime={new Date(event.created_at).toISOString()}>{new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(event.created_at)}</time> · {event.agent_name !== shown?.name && <bdi>{event.agent_name}{ui("として", " as ")}</bdi>}{event.action === 'joined' ? ui("参加", "Joined") : ui("退室", "Leave")}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {!shown && !error && <p role="status">{ui("読み込み中…", "Loading…")}</p>}
    </div>
  </Modal>;
}
