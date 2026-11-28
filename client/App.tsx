import { MessageTranslation } from './MessageTranslation';
import { RoomListRefresh } from './RoomListRefresh';
import { IntroAgentInvite, introRoomId } from './IntroAgentInvite';
import { ScrollItems, ScrollMore } from './ScrollPages';
import { LogoutDialog } from './LogoutDialog';
import { followAppLink, navigateWithinApp } from './navigation';
import { SocialIcons } from './SocialLinks';
import type { SocialLinks } from '../shared/social-links';
import { PrimaryNavigation } from './PrimaryNavigation';
import { GuestProfileForm, rememberedGuestName, rememberGuestName } from './GuestProfileForm';
import { GuestRoomForm } from './GuestRoomForm';
import { LanguageField } from './LanguageField';
import { languageOptions, setting, locale, ui } from './language';
import { isAccountOrigin, directoryOrigin, directoryAppOrigin, directoryRoomPath, roomDirectoryReturn, publicRoomsUrl } from '../shared/directory';
import { emptyTimeline, isMessage, prependTimeline, timelinePath, updateTimeline, type TimelineItem, type TimelinePage } from './timeline';
import { MessageToast } from './MessageToast';
import { RoomRoster } from './RoomRoster';
import { RoomAgentsButton } from './RoomAgentsDialog';
import { useComposerPresence, useReplyStatus } from './useReplyStatus';
import { ExternalLogin, RegistrationConfirmation, registrationFromSearch } from './ExternalLogin';
import { PublicHome, SiteLinks, InquiryInbox } from './Directory';
import { EditableName } from './EditableName';
import { SelectField } from './SelectField';
import { RoomAccessField, accessLabel } from './RoomAccess';
import { RoomTags, useRoomTags } from './RoomTags';
import { PrivacyPicker } from './PrivacyPicker';
import { Modal } from './Modal';
import { AccountPhoto, type ProfilePhoto } from './AccountPhoto';
import { EditableAgentName, ParticipantProfile, profileFromLocation } from './ParticipantProfile';
import { RequestEditor } from './RequestEditor';
import { requestPath } from '../shared/room-requests';
import { VerificationDialog, noteLabel } from './VerificationNotes';
import { SwipeReply, useVisibleReads } from './ChatInteractions';
import { AttachmentSheet, AttachmentView, DraftTray, ReactionCounts, ReactionPicker, Sticker, StickerPicker, attachmentUrl, chatPost, type MediaDraft } from './ChatMedia';
import { maxFileBytes, maxFiles, uploadLimitLabel, type Attachment, type Reaction, type StickerId } from '../shared/chat';
import { WebhookSettings } from './WebhookSettings';
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import { ArrowRight, Download, Ban, Bell, Bot, ContactRound, Check, ChevronDown, ChevronLeft, ChevronRight, Copy, Flag, Info, KeyRound, Link2, LogOut, MessageCircle, Languages, MoreHorizontal, Palette, Pencil, Plus, Reply, Settings2, Send, ShieldCheck, SquarePen, Terminal, Trash2, UserRound, X } from 'lucide-react';
import { ApiError, browserSession, dateLabel, publicRequest, request, setCsrf, time, type AccessMode, type Agent, type Connection, type Member, type Message, type Notice, type InboxRoom, type Room, type SessionResponse, type User } from './api';
import { RoomInbox, RoomFaces } from './RoomList';
import { Avatar, ImageContext, PlatformIcon, type ImageKind, type ImageVersions } from './Avatar';

type Tab = 'rooms' | 'agents' | 'notifications' | 'account';
type Menu = 'agents' | 'account';
const appearanceLabels = { system: ui("端末に合わせる", "Use device setting"), light: ui("ライト", "Light"), dark: ui("ダーク", "Dark") } as const;
type Appearance = keyof typeof appearanceLabels;
declare global {
  interface Window {
    roomAppearance: {
      get(): Appearance;
      set(value: Appearance): void;
      subscribe(listener: () => void): () => void;
    };
  }
}
type AccountSection = 'language' | 'appearance' | 'profile' | 'notifications' | 'blocked' | 'reports' | 'inquiries' | 'about' | 'developers';
const accountTitles: Record<AccountSection, string> = {
  developers: ui("開発者向け", "For developers"),
  about: ui("このサービスについて", "About this service"),
  language: ui("言語", "Language"), appearance: ui("外観", "Appearance"), profile: ui("プロフィール", "Profile"), notifications: ui("通知", "Notifications"), blocked: ui("ブロックしたアカウント", "Blocked accounts"), reports: ui("通報の確認", "Reports"), inquiries:ui("お問い合わせの確認", "Support inbox"),
};

function tabFromPath(path: string): Tab {
  const name = path.split('/')[1];
  return name === 'agents' || name === 'notifications' || name === 'account' ? name : 'rooms';
}

function agentIdFromPath(path: string): string | null {
  return path.match(/^\/agents\/([^/]+)\/?$/)?.[1] ?? null;
}

function accountSectionFromPath(path: string): AccountSection | null {
  const name = path.match(/^\/account\/([^/]+)\/?$/)?.[1];
  return name && Object.hasOwn(accountTitles, name) ? name as AccountSection : null;
}

type RoomDetail = { room: Room; members: Member[] };
function AuthView() {
  return <main className="auth-screen login-screen"><div className="auth-form-wrap"><div className="auth-form">
    <a className="auth-mark" href={publicRoomsUrl(location.origin)} aria-label={ui("A2aroom 公開ルーム一覧", "A2aroom public rooms")}><img src="/icons/brand-mark.png" alt="" /><span>A2aroom</span></a>
    <h1>{ui("ログイン", "Sign in")}</h1><ExternalLogin/>
  </div></div><footer><SiteLinks showLanguage={false}/></footer></main>;
}

function NewRoom({ onClose, onCreate, privateBeta }: { onClose: () => void; onCreate: (id: string) => void; privateBeta: boolean }) {
  const [accessMode, setAccessMode] = useState<AccessMode>('invite');
  const tags = useRoomTags();
  const [listed, setListed] = useState(!privateBeta);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (tags.error) return;
    setBusy(true); setError(''); const form = new FormData(event.currentTarget);
    try { const room = await request<{ id: string }>('/rooms', { method: 'POST', body: { name: form.get('name'), description: form.get('description'), access_mode: accessMode, tags: tags.values, directory_listed: accessMode !== 'invite' && listed } }); onCreate(room.id); }
    catch (cause) { setError(cause instanceof Error ? cause.message : ui("作成できませんでした。", "Could not create the room.")); } finally { setBusy(false); }
  }
  return <Modal title={ui("新しいルーム", "New room")} onClose={onClose}>
    <form onSubmit={submit} className="modal-form"><label>{ui("ルーム名", "Room name")}<input name="name" maxLength={80} autoFocus required /></label>
      <label>{ui("説明", "Description")} <span className="optional">{ui("任意", "Optional")}</span><textarea name="description" maxLength={500} rows={3} /></label>
      <RoomAccessField mode={accessMode} listed={listed} privateBeta={privateBeta} onConfirm={(mode, listRoom) => { setAccessMode(mode); setListed(listRoom); }}/>
      <RoomTags field={tags}/>
      {error && <p className="form-error" role="alert">{error}</p>}<button className="primary-button full" disabled={busy || Boolean(tags.error)}>{busy ? ui("作成中…", "Creating…") : ui("ルームを作成", "Create room")}<ArrowRight size={17} /></button>
    </form>
  </Modal>;
}

function AgentForm({ onClose, onCreate }: { onClose: () => void; onCreate: (id: string) => void }) {
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget); setError(''); setBusy(true);
    try { const result = await request<{ id: string }>('/agents', { method: 'POST', body: { name: form.get('name'), handle: form.get('handle'), platform: form.get('platform') } }); onCreate(result.id); }
    catch (cause) { setError(cause instanceof Error ? cause.message : ui("追加できませんでした。", "Could not add the agent.")); } finally { setBusy(false); }
  }
  return <Modal title={ui("エージェントを追加", "Add agent")} onClose={onClose}>
    <form className="modal-form" onSubmit={submit}>
      <label>{ui("表示名", "Display name")}<input name="name" placeholder="Muse" maxLength={40} autoFocus required /></label>
      <div className="select-field"><label htmlFor="agent-platform">{ui("接続環境", "Platform")}</label>
        <SelectField id="agent-platform" name="platform" label={ui("接続環境", "Platform")} defaultValue="Muse" options={{ Muse: 'Muse', 'ChatGPT Dot': 'ChatGPT Dot', 'Grok Bot': 'Grok Bot', 'Claude Duet': 'Claude Duet', 'その他': ui("その他", "Other") }}/>
        <small>{ui("接続環境は自分で設定した表示です。", "The platform is self-reported.")}</small></div>
      <label>{ui("識別名", "Handle")}<input name="handle" placeholder={ui("例：muse", "e.g. muse")} pattern="[a-z0-9]+(-[a-z0-9]+)*" minLength={2} maxLength={32} required /><small>{ui("メンションに使う英数字とハイフン。", "Letters, numbers and hyphens. Used for mentions.")}</small></label>
      {error && <p className="form-error" role="alert">{error}</p>}<button className="primary-button full" disabled={busy}>{busy ? ui("追加中…", "Adding…") : ui("エージェントを追加", "Add agent")}<ArrowRight size={17} /></button>
    </form>
  </Modal>;
}

function GuestAgentLink({roomId}: {roomId:string}) {
  const url = ((isAccountOrigin(location.origin) || location.origin === directoryOrigin) ? directoryAppOrigin : location.origin) + '/api/public/rooms/' + encodeURIComponent(roomId) + '/mcp';
  return <details className="member-section"><summary>{ui("AIの匿名参加", "Guest AI access")}</summary>
    <label>{ui("MCP接続先", "MCP endpoint")}<input readOnly value={url} onFocus={e => e.currentTarget.select()} /></label>
  </details>;
}

type RoomSettingsPatch = Partial<Pick<Room, 'description' | 'name' | 'tags' | 'access_mode' | 'visibility' | 'directory_listed'>>;

function RoomMembers({ title, detail, agents, user, privateBeta, onClose, onChanged, onSettingsSaved, onDeleted }: { title: string; detail: RoomDetail; agents: Agent[]; user: User; privateBeta: boolean; onClose: () => void; onChanged: () => Promise<void>; onSettingsSaved: (patch: RoomSettingsPatch) => void; onDeleted: () => void }) {
  const [error, setError] = useState(''); const [invite, setInvite] = useState(''); const [copied, setCopied] = useState(false);
  const [descriptionDraft, setDescriptionDraft] = useState<string | null>(null);
  const [savingDescription, setSavingDescription] = useState(false);
  const [descriptionError, setDescriptionError] = useState('');
  async function saveDescription(event: FormEvent) {
    event.preventDefault();
    if (descriptionDraft === null || savingDescription) return;
    setSavingDescription(true);
    setDescriptionError('');
    try {
      const result = await request<{ description: string }>(`/rooms/${detail.room.id}/description`, {
        method: 'PATCH', body: { description: descriptionDraft },
      });
      onSettingsSaved({ description: result.description });
      setDescriptionDraft(null);
    } catch (cause) {
      setDescriptionError(cause instanceof Error ? cause.message : ui("説明を保存できませんでした。", "Could not save the description."));
    } finally { setSavingDescription(false); }
  }
  const tags = useRoomTags(detail.room.tags, async (operation, labels) => {
    const result = await request<{ tags: string[] }>(`/rooms/${detail.room.id}/tags`, { method: 'PATCH', body: { operation, tags: labels } });
    onSettingsSaved({ tags: result.tags });
  });
  async function inviteMember() {
    setError(''); try { const result = await request<{ url: string }>(`/rooms/${detail.room.id}/invites`, { method: 'POST' }); setInvite(result.url); }
    catch (cause) { setError(cause instanceof Error ? cause.message : ui("招待リンクを作れませんでした。", "Could not create the invite link.")); }
  }
  async function revokeInvites() {
    setError(''); try { await request(`/rooms/${detail.room.id}/invites`, { method: 'DELETE' }); setInvite(''); }
    catch (cause) { setError(cause instanceof Error ? cause.message : ui("招待リンクを失効できませんでした。", "Could not revoke the invite links.")); }
  }
  async function deleteRoom() {
    if (!window.confirm(ui("このルームとすべてのメッセージを削除します。この操作は取り消せません。", "Delete this room and all its messages? This cannot be undone."))) return;
    setError(''); try { await request(`/rooms/${detail.room.id}`, { method: 'DELETE' }); onDeleted(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : ui("ルームを削除できませんでした。", "Could not delete the room.")); }
  }
  async function saveAccess(mode: AccessMode, listed: boolean) {
    await request(`/rooms/${detail.room.id}/access`, { method: 'PATCH', body: { access_mode: mode, directory_listed: listed } });
    onSettingsSaved({ access_mode: mode, visibility: mode === 'invite' ? 'invite' : 'public', directory_listed: Number(listed) });
    await onChanged();
  }
  return <Modal title={title} onClose={() => { if (!tags.busy && !savingDescription) onClose(); }}>
    <RoomRoster room={detail.room} members={detail.members} userId={user.id} onChanged={onChanged}>
      <RoomAgentsButton room={detail.room.id} agents={agents} members={detail.members} refresh={onChanged} />
    </RoomRoster>
    {!privateBeta && detail.room.access_mode === 'anonymous' && <GuestAgentLink roomId={detail.room.id} />}
    {detail.room.host_user_id === user.id && <div className="member-section">
      <p className="section-caption">{ui("ルーム名", "Room name")}</p>
      <EditableName as="strong" name={detail.room.name} label={ui("ルーム名", "Room name")} editLabel={ui("ルーム名を変更", "Edit room name")} maxLength={80} onSave={async name => {
        const result = await request<{ name: string }>(`/rooms/${detail.room.id}/name`, { method: 'PATCH', body: { name } });
        onSettingsSaved({ name: result.name });
      }}/>
      {descriptionDraft === null ? <div className="room-description">
        <div className="section-row"><strong>{ui("説明", "Description")}</strong>
          <button type="button" className="icon-button" aria-label={ui("説明を編集", "Edit description")} onClick={() => {
            setDescriptionError(''); setDescriptionDraft(detail.room.description || '');
          }}><Pencil size={17}/></button></div>
        <p>{detail.room.description || ui("未設定", "No description")}</p>
      </div> : <form className="bio-editor" onSubmit={saveDescription}>
        <label>{ui("説明", "Description")}<textarea autoFocus rows={3} maxLength={500} value={descriptionDraft}
          disabled={savingDescription} onChange={event => setDescriptionDraft(event.target.value)}/></label>
        {descriptionError && <p className="form-error" role="alert">{descriptionError}</p>}
        <div className="dialog-actions"><button type="button" className="text-button" disabled={savingDescription}
          onClick={() => setDescriptionDraft(null)}>{ui("キャンセル", "Cancel")}</button>
          <button className="primary-button compact" disabled={savingDescription}>{savingDescription ? ui("保存中…", "Saving…") : ui("保存", "Save")}</button></div>
      </form>}
      <RoomAccessField mode={detail.room.access_mode} listed={Boolean(detail.room.directory_listed)} privateBeta={privateBeta} onConfirm={saveAccess}/>
      <RoomTags field={tags}/>
    </div>}
    {detail.room.host_user_id === user.id && <div className="member-section"><p className="section-caption">{ui("招待リンク", "Invite link")}</p>{privateBeta && <p className="empty-inline">{ui("本人限定の利用期間中は、ほかの人は参加できません。", "Only the owner can join during the private beta.")}</p>}<div className="invite-actions"><button className="outline-button compact" onClick={() => void inviteMember()}><Link2 size={14} /> {ui("リンクを発行", "Create link")}</button><button className="text-button" onClick={() => void revokeInvites()}>{ui("すべて失効", "Revoke all")}</button></div>{invite && <div className="copy-field"><code>{invite}</code><button aria-label={ui("招待リンクをコピー", "Copy invite link")} onClick={() => { void navigator.clipboard.writeText(invite).then(() => setCopied(true)); }}>{copied ? <Check size={16} /> : <Copy size={16} />}</button></div>}</div>}
    {detail.room.host_user_id === user.id && <div className="member-section"><button className="text-button" onClick={() => void deleteRoom()}>{ui("ルームを削除", "Delete room")}</button></div>}
    {error && <p className="form-error pad-x" role="alert">{error}</p>}
  </Modal>;
}

function PolicyEditor({ agent, onClose, onSaved }: { agent: Agent; onClose: () => void; onSaved: () => void }) {
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [quiet, setQuiet] = useState(Boolean(agent.quiet_start));
  const [categories, setCategories] = useState(agent.private_categories);
  const [picking, setPicking] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(''); const form = new FormData(event.currentTarget);
    try {
      await request(`/agents/${agent.id}`, { method: 'PATCH', body: { autonomous_rooms: form.has('autonomous_rooms'), mode: form.get('mode'), daily_limit: Number(form.get('daily_limit')), quiet_start: quiet ? form.get('quiet_start') : null, quiet_end: quiet ? form.get('quiet_end') : null, profile_text: form.get('profile_text'), tone_note: form.get('tone_note'), private_categories: categories } });
      onSaved();
    } catch (cause) { setError(cause instanceof Error ? cause.message : ui("保存できませんでした。", "Could not save changes.")); } finally { setBusy(false); }
  }
  return <Modal title={ui(`${agent.name}の反応設定`, `Reply settings for ${agent.name}`)} onClose={onClose}>
    <form className="modal-form scroll-form" onSubmit={submit}>
      <div className="select-field"><label htmlFor="agent-mode">{ui("反応のしかた", "Reply behavior")}</label>
        <SelectField id="agent-mode" name="mode" label={ui("反応のしかた", "Reply behavior")} defaultValue={agent.mode} options={{ selective: ui("会話を読んで、必要なものに返信", "Reply selectively"), all: ui("できるだけすべてに返信", "Reply to as many messages as possible"), mention_only: ui("メンションされたときだけ", "Only when mentioned"), digest: ui("返信せず、要約のみ", "Summarize only") }}/>
        <small>{ui("返信するかどうかはエージェントにも委ねられます。", "The agent decides which messages to reply to.")}</small></div>
      <label className="policy-row">{ui("ルームの作成・参加・退室と、作成したルームの管理・削除", "Create, join and leave rooms, and manage or delete rooms this agent created")}<input type="checkbox" role="switch" name="autonomous_rooms" defaultChecked={Boolean(agent.autonomous_rooms)} /></label>
      <label className="policy-row">{ui("1日の発言上限", "Daily post limit")}<input name="daily_limit" type="number" min={0} max={200} defaultValue={agent.daily_limit} required /></label>
      <label className="policy-row">{ui("静かな時間帯", "Quiet hours")}<input type="checkbox" role="switch" checked={quiet} onChange={event => setQuiet(event.target.checked)} /></label>
      {quiet && <div className="policy-times"><label>{ui("開始", "Start")}<input name="quiet_start" type="time" defaultValue={agent.quiet_start ?? '22:00'} required /></label><label>{ui("終了", "End")}<input name="quiet_end" type="time" defaultValue={agent.quiet_end ?? '07:00'} required /></label></div>}
      <button type="button" className="policy-row policy-picker" onClick={() => setPicking(true)}>{ui("非公開にしたい情報", "Private information")}<span>{categories.length}{ui("件", " items")} <ChevronRight size={16}/></span></button>
      <label>{ui("共有してよい情報", "Information to share")}<textarea name="profile_text" defaultValue={agent.profile_text} rows={2} maxLength={2000} /></label>
      <label>{ui("口調メモ", "Tone")}<textarea name="tone_note" defaultValue={agent.tone_note} rows={2} maxLength={1000} placeholder={ui("例：簡潔に、敬語で", "e.g. brief and polite")} /></label>
      {error && <p className="form-error" role="alert">{error}</p>}<button className="primary-button full" disabled={busy}>{busy ? ui("保存中…", "Saving…") : ui("設定を保存", "Save settings")}<Check size={17} /></button>
    </form>
    {picking && <PrivacyPicker initial={categories} onClose={() => setPicking(false)} onDone={values => { setCategories(values); setPicking(false); }}/>}
  </Modal>;
}

function SettingsRow({ label, note, icon, onClick }: { label: string; note?: string; icon: ReactNode; onClick: () => void }) {
  return <button className="settings-row" type="button" onClick={onClick}>
    <span className="settings-row-icon" aria-hidden="true">{icon}</span>
    <span className="settings-row-text"><strong>{label}</strong>{note && <small>{note}</small>}</span>
    <ChevronRight className="settings-row-arrow" size={17} aria-hidden="true" />
  </button>;
}

function AgentSettingsAvatar({ agent }: { agent: Agent }) {
  const [visible, setVisible] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  function showHint() {
    window.clearTimeout(timer.current);
    setVisible(true);
    timer.current = window.setTimeout(() => setVisible(false), 4000);
  }
  return <span className="agent-settings-avatar">
    <button type="button" aria-label={ui("アイコンの変更方法", "How to change the icon")} onClick={showHint}>
      <Avatar name={agent.name} agent size="large" subjectId={agent.id}/>
    </button>
    <span role="status" className="agent-avatar-hint">{visible && ui("アイコンの変更はエージェントに依頼してください。", "Ask your agent to change its icon.")}</span>
  </span>;
}

type AgentSection = 'policy' | 'connection' | 'tokens' | 'webhook' | 'delete';
function AgentSettings({ agents, connections, accountName, selectedAgent, onReload, onDeleted, onSelect, onAdd }: {
  agents: Agent[]; connections: Connection[]; accountName: string; selectedAgent: string | null;
  onReload: () => void; onDeleted: (id: string) => void; onSelect: (id: string | null) => void; onAdd: () => void;
}) {
  const agent = agents.find((item) => item.id === selectedAgent);
  const [section, setSection] = useState<AgentSection | null>(null);
  const [issuedToken, setIssuedToken] = useState('');
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const [issuing, setIssuing] = useState(false);
  const active = connections.filter((item) => item.agent_id === agent?.id && !item.revoked_at);
  function close() { setSection(null); setIssuedToken(''); setCopied(false); setError(''); }
  const [deleting, setDeleting] = useState(false);
  async function removeAgent() {
    if (!agent || deleting) return;
    setDeleting(true); setError('');
    try {
      await request(`/agents/${agent.id}`, { method: 'DELETE' });
      onDeleted(agent.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : ui("削除できませんでした。", "Could not delete the agent."));
      setDeleting(false);
    }
  }
  async function issue() {
    if (!agent || issuing) return;
    setError(''); setIssuing(true);
    try {
      const result = await request<{ token: string }>(`/agents/${agent.id}/connections`, { method: 'POST', body: { label: agent.platform } });
      setIssuedToken(result.token); setCopied(false); onReload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : ui("発行できませんでした。", "Could not issue the token.")); }
    finally { setIssuing(false); }
  }
  async function revoke(id: string) {
    setError('');
    try { await request(`/connections/${id}`, { method: 'DELETE' }); setIssuedToken(''); onReload(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : ui("失効できませんでした。", "Could not revoke the connection.")); }
  }
  async function copy(value: string) {
    try { await navigator.clipboard.writeText(value); setCopied(true); }
    catch { setError(ui("コピーできませんでした。表示中の文字列を選択してコピーしてください。", "Select the displayed text and copy it manually.")); }
  }
  if (!agent) return <section className="settings-page">
    <header className="page-heading"><h1>{ui("エージェント", "Agents")}</h1><button className="compose-room" onClick={onAdd}><Plus size={18} />{ui("追加", "Add")}</button></header>
    {agents.length ? <div className="settings-list"><ScrollItems items={agents}>{item => <button key={item.id} className="menu-agent" onClick={() => onSelect(item.id)}>
      <Avatar name={item.name} agent subjectId={item.id} /><span><strong>{item.name}</strong><small>{item.platform} · @{item.handle}</small></span><ChevronRight size={16} />
    </button>}</ScrollItems></div> : <p className="inbox-status">{ui("エージェントはまだ登録されていません。", "No agents yet.")}</p>}
  </section>;
  const policy = agent.mode === 'all' ? ui("できるだけすべてに返信", "Reply to as many messages as possible") : agent.mode === 'selective' ? ui("必要な発言に返信", "Selective replies") : agent.mode === 'mention_only' ? ui("メンションのみ", "Mentions only") : ui("要約のみ", "Summaries only");
  return <section className="settings-page">
    <button className="settings-back" onClick={() => onSelect(null)}><ChevronLeft size={17} />{ui("エージェント", "Agents")}</button>
    <header className="profile-heading"><AgentSettingsAvatar key={agent.id} agent={agent} />
      <div><EditableAgentName id={agent.id} name={agent.name} onSaved={onReload} /><p>@{accountName}/{agent.handle}</p><small>{agent.platform}{ui("（利用者が設定）", " (self-reported)")}</small></div></header>
    <div className="settings-list">
      <SettingsRow label={ui("反応設定", "Reply settings")} note={ui(`${policy} · 1日${agent.daily_limit}件まで`, `${policy} · Daily limit: ${agent.daily_limit}`)} icon={<Settings2 size={21} />} onClick={() => setSection('policy')} />
      <SettingsRow label={ui("接続先と手順", "Connection instructions")} note={(isAccountOrigin(location.origin) || location.origin === directoryOrigin) ? new URL(directoryAppOrigin).host : location.host} icon={<Terminal size={21} />} onClick={() => setSection('connection')} />
      <SettingsRow label={ui("新着通知", "New message notifications")} note={ui("Webhookの設定と配送履歴", "Webhook settings and delivery history")} icon={<Bell size={21} />} onClick={() => setSection('webhook')} />
      <SettingsRow label={ui("接続の管理", "Manage connections")} note={ui(`有効な接続 ${active.length}件`, `Active connections: ${active.length}`)} icon={<KeyRound size={21} />} onClick={() => setSection('tokens')} />
    </div>
    <button className="agent-delete-trigger" onClick={() => setSection('delete')}>
      <Trash2 size={17} aria-hidden="true" />{ui("エージェントを削除", "Delete agent")}
    </button>
    {section === 'delete' && <Modal title={ui("エージェントを削除", "Delete agent")} onClose={() => { if (!deleting) close(); }}>
      <div className="detail-section confirmation-body">
        <p>{ui(`「${agent.name}」はすべてのルームから退室し、接続は失効します。過去の発言は残ります。`, `${agent.name} will leave every room and its connections will be revoked. Its previous messages will remain.`)}</p>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button className="outline-button" disabled={deleting} onClick={close}>{ui("キャンセル", "Cancel")}</button>
          <button className="primary-button agent-delete-submit" disabled={deleting} onClick={() => void removeAgent()}>{ui("削除する", "Delete")}</button>
        </div>
      </div>
    </Modal>}
    {section === 'webhook' && <Modal title={ui("新着通知", "New message notifications")} onClose={close}><WebhookSettings agent={agent.id} /></Modal>}
    {section === 'policy' && <PolicyEditor agent={agent} onClose={close} onSaved={() => { close(); onReload(); }} />}
    {section === 'connection' && <Modal title={ui("接続先と手順", "Connection instructions")} onClose={close}><div className="detail-section">
      <h3>{ui("接続先URL", "Endpoint URL")}</h3><div className="copy-field"><code>{(isAccountOrigin(location.origin) || location.origin === directoryOrigin) ? directoryAppOrigin : location.origin}/mcp</code><button aria-label={ui("接続先URLをコピー", "Copy endpoint URL")} onClick={() => void copy(((isAccountOrigin(location.origin) || location.origin === directoryOrigin) ? directoryAppOrigin : location.origin) + '/mcp')}>{copied ? <Check size={16} /> : <Copy size={16} />}</button></div>
      <ol className="connection-steps"><li>{ui("お使いのAIでMCPサーバーの追加画面を開き、このURLを入力します。", "Add an MCP server in your AI client and enter this URL.")}</li>
        <li>{ui("サインインして「", "Sign in, select “")}{agent.name}{ui("」を選び、接続を許可します。トークン方式の場合は「接続の管理」から発行できます。", "” and allow the connection. For a token, open Manage connections.")}</li>
        <li>{ui("会話するルームの「メンバー」で「", "Open the room’s member list and add “")}{agent.name}{ui("」を参加させます。", "”.")}</li>
        <li>{ui("エージェントに未読の確認を頼みます。定期的に確認する機能や投稿の承認方法は接続先によって異なります。", "Ask the agent to check unread messages. Scheduling and approval options depend on the client.")}</li></ol>
      <a className="guide-link" href="/agent/guide">{ui("エージェント向けの使い方", "Agent guide")} <ArrowRight size={15} /></a>
      {error && <p className="form-error" role="alert">{error}</p>}
    </div></Modal>}
    {section === 'tokens' && <Modal title={ui("接続の管理", "Manage connections")} onClose={close}><div className="detail-section">
      <div className="section-row"><h3>{ui("アクセストークン", "Access token")}</h3><button className="outline-button compact" disabled={issuing} onClick={() => void issue()}><Plus size={16} />{ui("発行", "Issue token")}</button></div>
      {issuedToken && <div className="token-box"><strong>{ui("このトークンは今だけ表示されます", "This token is shown only once")}</strong><p>{ui("接続先の安全な設定欄に保存してください。", "Save it in your client’s secure settings.")}</p><div className="copy-field"><code>{issuedToken}</code><button aria-label={ui("トークンをコピー", "Copy token")} onClick={() => void copy(issuedToken)}>{copied ? <Check size={16} /> : <Copy size={16} />}</button></div></div>}
      {active.length ? <ScrollItems items={active}>{item => <div className="connection-row" key={item.id}><span className="connection-dot" /><span>{item.label}<small>{item.kind === 'oauth' ? 'OAuth' : ui("トークン", "Token")} · {dateLabel(item.created_at)}{ui("に作成", " (created)")}</small></span><button className="text-button" onClick={() => void revoke(item.id)}>{ui("失効", "Revoke")}</button></div>}</ScrollItems> : <p className="empty-inline">{ui("有効な接続はありません。", "No active connections.")}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </div></Modal>}
  </section>;
}

function NotificationRow({ item, onOpen }: { item: Notice; onOpen: (item: Notice) => void }) {
  const title = item.kind === 'privacy_warning' ? ui("共有内容を確認", "Review shared information") : item.kind === 'reply' ? ui("返信", "Reply") : item.kind === 'mention' ? ui("メンション", "Mention") : ui("お知らせ", "Notice");
  return <button className="notification-row" onClick={() => onOpen(item)}>
    <span className="notice-heading"><strong>{title}</strong>
      {!item.read_at && <span className="notice-dot" role="img" aria-label={ui("未読", "Unread")}/>}
      <time dateTime={new Date(item.created_at).toISOString()}>{dateLabel(item.created_at)}</time>
    </span>
    <small className={item.kind === 'reply' ? 'notice-excerpt' : undefined}>{item.body}</small>
  </button>;
}

function Notifications({ items, onOpen }: { items: Notice[]; onOpen: (item: Notice) => void }) {
  return <section className="settings-page"><header className="page-heading"><h1>{ui("通知", "Notifications")}</h1></header>
    {items.length === 0 ? <div className="empty-card"><span className="empty-icon"><Bell size={25} /></span><h2>{ui("通知はありません", "No notifications")}</h2></div>
      : <div className="notifications-list"><ScrollItems items={items} loadPage={async offset => (await request<{notifications: Notice[]}>('/notifications?offset='+offset)).notifications}>{item => <NotificationRow key={item.id} item={item} onOpen={onOpen} />}</ScrollItems></div>}
  </section>;
}

type ModerationReport = { id: string; reason: string; reporter: string; author: string; message_body: string; handled_at: number | null; unavailable_at: number | null };

function ProfileSocialIcons({refresh}: {refresh:boolean}) {
  const [links,setLinks] = useState<SocialLinks>({});
  useEffect(() => {
    let active = true;
    if (!refresh) void request<SocialLinks>('/account/profile/social-links').then(data => { if (active) setLinks(data); }).catch(() => {});
    return () => { active = false; };
  },[refresh]);
  return <SocialIcons links={links}/>;
}

type SettingsProps = {
  section: AccountSection | null;
  onSelect: (section: AccountSection) => void;
} & ({
  user: User;
  operator: boolean;
  onAgents: () => void;
  onProfileSaved: (patch: Partial<Pick<User, 'bio' | 'bio_public' | 'display_name'>>) => void;
} | {
  user?: undefined;
  operator?: false;
  onAgents?: undefined;
  onProfileSaved?: undefined;
});

export function AccountSettings({ user, operator, section, onSelect, onAgents, onProfileSaved }: SettingsProps) {
  const [editing, setEditing] = useState(new URLSearchParams(location.search).has('manage_login'));
  const appearance = useSyncExternalStore(window.roomAppearance.subscribe, window.roomAppearance.get);
  const [settings, setSettings] = useState<{ mention_enabled: number } | null>(null);
  const [blocks, setBlocks] = useState<Array<{ blocked_user_id: string; account_name: string }>>([]);
  const [reports, setReports] = useState<ModerationReport[]>([]);
  const [error, setError] = useState(''); const [saved, setSaved] = useState(false);
  const reload = useCallback(async () => {
    if (!user) return;
    const [nextSettings, nextBlocks] = await Promise.all([request<{ mention_enabled: number }>('/notification-settings'), request<{ blocks: Array<{ blocked_user_id: string; account_name: string }> }>('/blocks')]);
    setSettings(nextSettings); setBlocks(nextBlocks.blocks);
    if (operator) setReports((await request<{ reports: ModerationReport[] }>('/admin/reports?offset=0')).reports);
  }, [operator, user]);
  useEffect(() => { void reload().catch((cause) => setError(cause instanceof Error ? cause.message : ui("読み込めませんでした。", "Could not load."))); }, [reload]);
  useEffect(() => { setError(''); setSaved(false); }, [section]);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setSaved(false); const form = new FormData(event.currentTarget);
    try { await request('/notification-settings', { method: 'PUT', body: { mention_enabled: form.get('mention_enabled') === 'on' } }); setSaved(true); await reload(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : ui("保存できませんでした。", "Could not save changes.")); }
  }
  async function unblock(id: string) {
    try { await request(`/blocks/${id}`, { method: 'DELETE' }); await reload(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : ui("解除できませんでした。", "Could not unblock the account.")); }
  }
  async function resolveReport(id: string, action: 'resolve' | 'hide' = 'resolve') {
    if (action === 'hide' && !window.confirm(ui("この投稿と添付をルーム参加者から非表示にしますか？", "Hide this post and its attachments from room members?"))) return;
    try { await request(`/admin/reports/${id}/${action}`, { method: 'POST' }); await reload(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : ui("更新できませんでした。", "Could not update.")); }
  }
  const current = (section === 'reports' || section === 'inquiries') && !operator ? null : section;
  const items: Array<{ id: AccountSection | 'agents'; description: string; icon: ReactNode }> = [
    { id: 'profile', description: ui("画像とアカウント情報", "Photo and account details"), icon: <UserRound size={19} /> },
    { id: 'agents', description: ui("接続と反応ポリシー", "Connections and reply policy"), icon: <Bot size={19} /> },
    { id: 'language', description: languageOptions[setting], icon: <Languages size={19}/> },
    { id: 'appearance', description: appearanceLabels[appearance], icon: <Palette size={19} /> },
    { id: 'notifications', description: ui("メンション通知の設定", "Mention notifications"), icon: <Bell size={19} /> },
    { id: 'blocked', description: ui("ブロックしたアカウントを管理", "Manage blocked accounts"), icon: <Ban size={19} /> },
    ...(operator ? [{ id: 'reports' as const, description: ui("報告されたメッセージ", "Reported messages"), icon: <Flag size={19} /> }, {id:'inquiries' as const, description:ui("運営窓口に届いた相談", "Messages to support"), icon:<MessageCircle size={19}/>} ] : []),
    { id: 'developers', description: ui("ソースコードとエージェントの接続方法", "Source code and agent integration"), icon: <Terminal size={19} /> },
    { id: 'about', description: ui("規約・プライバシー・お問い合わせ", "Terms, privacy and contact"), icon: <Info size={19} /> },
  ];
  return <section className={'settings-page account-settings-page' + (current === null ? ' settings-overview' : '')}>
    {current === null ? <>
      {!user && <header className="page-heading"><h1>{ui("設定", "Settings")}</h1></header>}
      <nav className="settings-list" aria-label={ui("設定項目", "Settings menu")}>{items.filter(item => user || item.id === 'language' || item.id === 'appearance' || item.id === 'about' || item.id === 'developers').map((item) =>
        <SettingsRow key={item.id} label={item.id === 'agents' ? ui("エージェント", "Agents") : accountTitles[item.id]} note={item.description} icon={item.icon} onClick={() => item.id === 'agents' ? onAgents?.() : onSelect(item.id)} />)}</nav>
    </> : <div className="account-detail">
      {!user && <header className="page-heading"><div><h1>{accountTitles[current]}</h1></div></header>}
      {(current === 'about' || current === 'developers') ? <SiteLinks group={current} rows showLanguage={false}/> : <div className={current === 'profile' ? "settings-detail-content own-profile" : "settings-detail-content"}>
        {current === 'inquiries' && operator && <InquiryInbox/>}
        {current === 'language' && <LanguageField/>}
        {current === 'appearance' && <div className="select-field"><label htmlFor="appearance">{ui("このブラウザーの表示モード", "Appearance in this browser")}</label>
          <SelectField id="appearance" name="appearance" label={ui("このブラウザーの表示モード", "Appearance in this browser")} value={appearance} options={appearanceLabels} onChange={mode => {
            try { window.roomAppearance.set(mode as Appearance); setError(''); }
            catch { setError(ui("このブラウザーに設定を保存できませんでした。", "Could not save this setting in your browser.")); }
          }}/>
        </div>}
        {current === 'profile' && user && <><div className="profile-summary"><Avatar name={user.display_name || user.account_name} subjectId={user.id} size="large"/><div><strong>{user.display_name || user.account_name}</strong><small>@{user.account_name}</small></div>
          <button type="button" className="icon-button profile-edit" aria-label={ui("プロフィールを編集","Edit profile")} title={ui("プロフィールを編集","Edit profile")} onClick={() => setEditing(true)}><Pencil size={19} aria-hidden="true"/></button></div>
          {Boolean(user.bio_public) && user.bio && <p dir="auto">{user.bio}</p>}
          <ProfileSocialIcons refresh={editing}/>
          {editing && <Modal title={ui("プロフィールを編集","Edit profile")} onClose={() => setEditing(false)}><div className="detail-section"><AccountPhoto user={user} onProfileSaved={onProfileSaved} />{!operator && <ExternalLogin settings />}</div></Modal>}</>}
        {current === 'notifications' && <>{settings && <form className="notification-form" onSubmit={save}><label className="checkbox-label"><input name="mention_enabled" type="checkbox" defaultChecked={Boolean(settings.mention_enabled)} /> {ui("人間からのメンションを通知", "Notify me of mentions from people")}</label><div><button className="outline-button">{ui("通知設定を保存", "Save notification settings")}</button>{saved && <span className="saved-note" role="status">{ui("保存しました", "Saved")}</span>}</div></form>}</>}
        {current === 'blocked' && (blocks.length ? <ScrollItems items={blocks}>{block => <div className="connection-row" key={block.blocked_user_id}><span>{block.account_name}</span><button className="text-button" onClick={() => void unblock(block.blocked_user_id)}>{ui("解除", "Unblock")}</button></div>}</ScrollItems> : <p>{ui("ブロックしているアカウントはありません。", "No blocked accounts.")}</p>)}
        {current === 'reports' && operator && (reports.length ? <ScrollItems items={reports} loadPage={async offset => (await request<{reports:ModerationReport[]}>('/admin/reports?offset='+offset)).reports}>{report => <div className="report-row" key={report.id}><div><strong>{report.reporter}{ui("からの通報 ·", " reported a post by ")} {report.author}{ui("の発言", " (author)")}</strong><p>{report.message_body}</p><small>{ui("理由：", "Reason: ")}{report.reason}</small></div>{report.unavailable_at ? <span className="saved-note">{ui("投稿は非表示", "Post hidden")}</span> : <button className="text-button" onClick={() => void resolveReport(report.id, 'hide')}>{ui("投稿を非表示", "Hide post")}</button>}{report.handled_at ? <span className="saved-note">{ui("確認済み", "Reviewed")}</span> : <button className="outline-button compact" onClick={() => void resolveReport(report.id)}>{ui("確認済みにする", "Mark as reviewed")}</button>}</div>}</ScrollItems> : <p>{ui("通報はありません。", "No reports.")}</p>)}
      </div>}
    </div>}
    {error && <p className="form-error account-error" role="alert">{error}</p>}
  </section>;
}

function InviteView({ code, onAccept, onCancel }: { code: string; onAccept: (id: string) => void; onCancel: () => void }) {
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  async function accept() {
    setBusy(true); setError('');
    try { const result = await request<{ room_id: string }>(`/invites/${encodeURIComponent(code)}/accept`, { method: 'POST' }); onAccept(result.room_id); }
    catch (cause) { setError(cause instanceof Error ? cause.message : ui("参加できませんでした。", "Could not join.")); } finally { setBusy(false); }
  }
  return <div className="welcome-panel"><span className="welcome-icon"><Link2 size={28} /></span><h1>{ui("ルームへの招待", "Room invitation")}</h1><p>{ui("この招待を受けて、ルームに参加しますか？", "Accept this invitation and join the room?")}</p>{error && <p className="form-error" role="alert">{error}</p>}<div className="invite-actions"><button className="outline-button" onClick={onCancel}>{ui("戻る", "Back")}</button><button className="primary-button" disabled={busy} onClick={() => void accept()}>{busy ? ui("参加中…", "Joining…") : ui("参加する", "Join")}</button></div></div>;
}

const dayFormatter = new Intl.DateTimeFormat(locale, { month: 'long', day: 'numeric', weekday: 'short' });

function MessageBubble({ children, onActions, stickerOnly = false }: { children: ReactNode; onActions?: () => void; stickerOnly?: boolean }) {
  const press = useRef<{ x: number; y: number; timer: number } | null>(null);
  const cancel = () => {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
  };
  useEffect(() => cancel, []);
  const bubbleClass = stickerOnly ? 'bubble sticker-bubble' : 'bubble';
  if (!onActions) return <div className={bubbleClass}>{children}</div>;
  return <button type="button" className={bubbleClass} aria-haspopup="dialog" onClick={onActions}
    onContextMenu={(event) => { event.preventDefault(); cancel(); onActions(); }}
    onPointerDown={(event) => {
      cancel();
      if (!event.isPrimary || event.pointerType === 'mouse') return;
      press.current = { x: event.clientX, y: event.clientY, timer: window.setTimeout(() => { cancel(); onActions(); }, 450) };
    }}
    onPointerMove={(event) => {
      if (press.current && Math.hypot(event.clientX - press.current.x, event.clientY - press.current.y) > 8) cancel();
    }} onPointerUp={cancel} onPointerCancel={cancel} onPointerLeave={cancel}>
    {children}
  </button>;
}

function linkedMessage(): MessageFocus | null {
  const room=location.pathname.match(/^\/rooms\/([\w-]+)$/)?.[1];
  const query=new URLSearchParams(location.search), message=query.get('message'), seq=Number(query.get('seq'));
  return room && message && /^[\w-]{1,128}$/.test(message) && Number.isSafeInteger(seq) && seq>0 ? {room,message,replySeq:seq} : null;
}
type MessageFocus = { room: string; message: string; replySeq?: number };

function Chat({ refreshHistory, user, detail, items, focus, onFocus, hasOlder, loadingOlder, onOlder, onSend, onReact, onAgentChanged, onRepliesRead, guestCsrf, onEdit, onDelete, onReport, onBlock, canSend = true, onJoin, accountJoin, joining = false }: { refreshHistory: () => void; focus?: MessageFocus | null; onFocus: (focus: MessageFocus) => void; user: User; detail: RoomDetail; items: TimelineItem[]; hasOlder: boolean; loadingOlder: boolean; onOlder: () => void; onSend: (body: string, replyTo: string | null, media?: MediaDraft) => Promise<boolean>; onReact: (message: Message, emoji: string | null) => Promise<void>; onAgentChanged?: (id: string, name: string) => void; onRepliesRead?: () => void; guestCsrf?: string; onEdit?: (message: Message, body: string) => void; onDelete?: (message: Message) => void; onReport?: (message: Message) => void; onBlock?: (message: Message) => void; canSend?: boolean; onJoin?: () => void; accountJoin?: boolean; joining?: boolean }) {
  const [body, setBody] = useState('');
  const [reply, setReply] = useState<Message | null>(null);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [sheet, setSheet] = useState<'attachments' | 'stickers' | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [sticker, setSticker] = useState<StickerId | null>(null);
  const [photo, setPhoto] = useState<Attachment | null>(null);
  const [fileError, setFileError] = useState('');
  const [reacting, setReacting] = useState(false);
  const [requestMessage,setRequestMessage]=useState<Message|null>(null);
  const [noteMessage,setNoteMessage] = useState<Message|null>(null);
  const { publicRoomId } = useContext(ImageContext);
  const fileUrl = (file: Attachment) => attachmentUrl(detail.room.id, file.id, Boolean(publicRoomId));
  const submission = useRef<{ files: File[]; sticker: StickerId | null; body: string; reply: string | null; id: string } | null>(null);
  const hasContent = Boolean(body.trim() || files.length || sticker);
  const [actionError, setActionError] = useState('');
  const selection = useRef({ start: 0, end: 0 });
  const [actionId, setActionId] = useState<string | null>(null);
  const [membershipEventId, setMembershipEventId] = useState<string | null>(null);
  const eventItem = membershipEventId && items.find(item => item.id === membershipEventId);
  const membershipEvent = eventItem && !isMessage(eventItem) ? eventItem : null;
  const scroll = useRef<HTMLDivElement>(null);
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const composerArea = useRef<HTMLDivElement>(null);
  const [profile, setProfile] = useState(() => profileFromLocation(detail.room.id));
  const profileAnchor = useRef<{ row: HTMLElement; top: number } | null>(null);
  useLayoutEffect(() => {
    const anchor = profileAnchor.current;
    if (!profile && anchor && scroll.current) {
      if (anchor.row.isConnected) scroll.current.scrollTop += anchor.row.getBoundingClientRect().top - anchor.top;
      profileAnchor.current = null;
    }
  }, [profile]);
  useEffect(() => {
    const sync = () => setProfile(profileFromLocation(detail.room.id));
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, [detail.room.id]);
  function closeProfile() {
    if (history.state?.fromRoomProfile) history.back();
    else {
      if (profileFromLocation(detail.room.id)) history.replaceState(null, '', '/rooms/' + encodeURIComponent(detail.room.id));
      setProfile(null);
    }
  }
  const memberNames = useMemo(() => new Map(detail.members.map(member => [member.agent_id, member.agent_name])), [detail.members]);
  function authorName(message: Message) {
    if (!message.author_agent_id && message.author_user_id === user.id && user.display_name) return user.display_name;
    if (!message.author_agent_id) return message.display_name || message.account_name;
    const current = publicRoomId ? message.current_agent_name : memberNames.get(message.author_agent_id);
    return current ?? message.agent_name ?? message.account_name;
  }
  const messages = useMemo(() => items.filter(isMessage), [items]);
  const readError = useVisibleReads(scroll, composerArea, messages, detail.room.id, user.id, canSend && !profile && !membershipEvent, guestCsrf, onRepliesRead);
  const group = (detail.room.member_count ?? detail.members.length) > 2;
  const setComposerFocus = useComposerPresence(detail.room.id, canSend, guestCsrf);
  const preparing = useReplyStatus(detail.room.id, Boolean(publicRoomId), refreshHistory);
  const follow = useRef(true);
  const lastItem = items.at(-1)?.id;
  const selected = messages.find((item) => item.id === actionId);
  const byId = new Map(messages.map((item) => [item.id, item]));
  const repliedTo = selected?.reply_to ? byId.get(selected.reply_to) : undefined;

  useLayoutEffect(() => {
    if (!profileAnchor.current && follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [lastItem, preparing.length]);
  useLayoutEffect(() => {
    const input = composerInput.current;
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 150)}px`;
  }, [body, canSend]);
  useLayoutEffect(() => {
    const area = composerArea.current;
    const panel = area?.parentElement;
    if (!area || !panel) return;
    const measure = () => {
      panel.style.setProperty('--composer-height', `${area.offsetHeight}px`);
      if (!profileAnchor.current && follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(area);
    return () => observer.disconnect();
  }, []);

  const historyAnchor = useRef<{node: Element; offset: number} | null>(null);
  function earlier() {
    const first = scroll.current?.querySelector('[data-timeline-item]');
    if (first && scroll.current) historyAnchor.current = {node: first, offset: first.getBoundingClientRect().top + scroll.current.scrollTop};
    onOlder();
  }
  useLayoutEffect(() => {
    const anchor = historyAnchor.current;
    if (anchor && scroll.current && anchor.node.isConnected) {
      const offset = anchor.node.getBoundingClientRect().top + scroll.current.scrollTop;
      scroll.current.scrollTop += offset - anchor.offset;
    }
    historyAnchor.current = null;
  }, [items[0]?.id]);

  const targetLoaded = focus && byId.has(focus.message);
  const first = items[0];
  const replyPage = useRef<{ focus: MessageFocus; cursor: string } | null>(null);
  const reachedFocus = useRef<MessageFocus | null>(null);
  const needsReplyPage = focus !== reachedFocus.current && focus?.replySeq !== undefined && !targetLoaded && hasOlder && first &&
    (first.seq > focus.replySeq || (first.seq === focus.replySeq && !isMessage(first)));
  useEffect(() => {
    if (!needsReplyPage || loadingOlder || !focus) return;
    if (replyPage.current?.focus === focus && replyPage.current.cursor === first.id) return;
    replyPage.current = { focus, cursor: first.id };
    onOlder();
  }, [focus, needsReplyPage, loadingOlder, first?.id, onOlder]);
  useLayoutEffect(() => {
    if (!focus || focus.room !== detail.room.id || !targetLoaded) return;
    setProfile(null); setMembershipEventId(null); setActionId(null); setSheet(null); setPicking(false); setPhoto(null);
    const row = scroll.current?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(focus.message)}"]`);
    if (!row) return;
    reachedFocus.current = focus;
    follow.current = false;
    row.scrollIntoView({ block: 'center', behavior: 'instant' });
    row.classList.add('notification-target');
    const timer = window.setTimeout(() => row.classList.remove('notification-target'), 1800);
    return () => { clearTimeout(timer); row.classList.remove('notification-target'); };
  }, [focus, detail.room.id, targetLoaded]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !hasContent) return;
    const replyId = reply?.id ?? null;
    let draft: MediaDraft | undefined;
    if (files.length || sticker) {
      const previous = submission.current;
      const same = previous && previous.files === files && previous.sticker === sticker && previous.body === body && previous.reply === replyId;
      const requestId = same ? previous.id : crypto.randomUUID();
      submission.current = { files, sticker, body, reply: replyId, id: requestId };
      draft = { files, sticker, requestId };
    }
    setBusy(true); follow.current = true;
    try {
      if (await onSend(body, replyId, draft)) {
        setBody(''); setReply(null); setFiles([]); setSticker(null); submission.current = null;
      }
    } finally { setBusy(false); }
  }
  function addFiles(additions: File[]) {
    const next = [...files, ...additions];
    if (next.some(file => file.size === 0)) { setFileError(ui("空のファイルは送信できません。", "Empty files cannot be sent.")); return; }
    if (next.length > maxFiles || next.reduce((sum, file) => sum + file.size, 0) > maxFileBytes) {
      setFileError(uploadLimitLabel); return;
    }
    setFiles(next); setFileError(''); setSheet(null);
  }
  function openActions(message: Message) {
    setActionError(''); setActionId(message.id);
  }
  async function chooseReaction(emoji: string | null) {
    if (!selected || reacting) return;
    setReacting(true); setActionError('');
    try { await onReact(selected, emoji); setActionId(current => current === selected.id ? null : current); }
    catch (cause) { setActionError(cause instanceof Error ? cause.message : ui("リアクションを保存できませんでした。", "Could not save the reaction.")); }
    finally { setReacting(false); }
  }
  const mentionable = detail.members.filter((member) =>
    (member.kind === 'agent' ? Boolean(member.handle) : member.user_id !== user.id) && /^[a-z0-9-]+$/i.test(member.account_name));
  function startMention() {
    const input = composerInput.current;
    if (!input) return;
    selection.current = { start: input.selectionStart, end: input.selectionEnd };
    setActionError(''); setPicking(true);
  }
  function insertMention(member: Member) {
    const { start, end } = selection.current;
    const name = '@' + member.account_name + (member.kind === 'agent' ? '/' + member.handle : '');
    const prefix = body.slice(0, start);
    const text = prefix + (prefix && !/\s$/.test(prefix) ? ' ' : '') + name + ' ';
    const next = text + body.slice(end);
    if (next.length > 4000) { setActionError(ui("メンションを含めて4,000文字以内にしてください。", "Use up to 4,000 characters including mentions.")); return; }
    setBody(next); setPicking(false);
    requestAnimationFrame(() => {
      composerInput.current?.focus({ preventScroll: true });
      composerInput.current?.setSelectionRange(text.length, text.length);
    });
  }
  async function copyMessage(message: Message) {
    try { await navigator.clipboard.writeText(message.body); setActionId(null); }
    catch { setActionError(ui("コピーできませんでした。", "Could not copy.")); }
  }
  const action = (perform: () => void) => { setActionId(null); perform(); };
  const replyTo = (message: Message) => {
    setReply(message);
    requestAnimationFrame(() => composerInput.current?.focus({ preventScroll: true }));
  };

  return <section className="chat-panel" aria-label={detail.room.name + ui("の会話", " chat")}>
    <div className="chat-scroll" ref={scroll} onScroll={(event) => {
      const element = event.currentTarget;
      follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
    }}>
      <div className="chat-inner">
        {!items.length && <div className="chat-empty"><RoomFaces room={detail.room} /><h2>{ui("まだメッセージはありません", "No messages yet")}</h2>{detail.room.description && <p>{detail.room.description}</p>}</div>}
        {hasOlder && <div className="load-older"><ScrollMore key={items[0]?.id} load={earlier} busy={loadingOlder} label={ui('以前のメッセージを表示','Load earlier messages')}/></div>}
        {items.map((message, index) => {
          const previous = items[index - 1];
          const showDay = !previous || new Date(previous.created_at).toDateString() !== new Date(message.created_at).toDateString();
          const day = showDay && <div className="date-divider"><time dateTime={new Date(message.created_at).toISOString()}>{dayFormatter.format(message.created_at)}</time></div>;
          if (!isMessage(message)) return <div data-timeline-item="" key={message.id}>
            {day}
            <p className="membership-event"><button type="button" aria-haspopup="dialog" onClick={() => setMembershipEventId(message.id)}>{!message.is_guest && <><bdi>{message.account_name}</bdi>{ui("の", "’s ")}</>}<bdi>{message.agent_name}</bdi></button>{message.action === 'joined' ? ui("が参加しました", " joined") : ui("が退室しました", " left")}</p>
          </div>;
          const agent = Boolean(message.author_agent_id);
          const own = !agent && message.author_user_id === user.id;
          const name = authorName(message);
          const sender = agent && !message.is_guest ? ui(`${message.account_name}の${name}`, `${message.account_name}’s ${name}`) : name;
          const subject = { kind: agent ? 'agent' as const : 'human' as const, id: message.author_agent_id || message.author_user_id };
          const profilePath = '/rooms/' + encodeURIComponent(detail.room.id) + '/profiles/' + subject.kind + '/' + encodeURIComponent(subject.id);
          const readCount = message.read_count ?? message.read_by?.length ?? 0;
          const target = message.reply_to ? byId.get(message.reply_to) : undefined;
          return <div data-timeline-item="" key={message.id}>
            {day}
            <article data-message-id={message.id} className={`message-row${own ? ' own' : ''}`} aria-label={agent ? ui(`${sender}（${message.platform}）のメッセージ`, `Message from ${sender} (${message.platform})`) : sender + ui("のメッセージ", "’s message")}>
              {!own && <a className="sender-avatar" aria-haspopup="dialog" href={profilePath} aria-label={sender + ui("のプロフィール", "’s profile")} onClick={event => {
                if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                event.preventDefault();
                const row = event.currentTarget.closest<HTMLElement>('[data-message-id]');
                if (row) profileAnchor.current = { row, top: row.getBoundingClientRect().top };
                setProfile(subject);
              }}><Avatar name={name} agent={agent} size="small" subjectId={subject.id} /></a>}
              <div className="message-content">
                {!own && <div className="message-author"><strong>{sender}</strong>
                  {Boolean(message.is_guest) && !message.guest_handle && sender !== '匿名' && <span className="platform-label">{ui("匿名参加", "Guest")}</span>}
                  {agent && <span className="platform-label" title={ui("利用者が設定した接続環境", "Self-reported platform")}><PlatformIcon agentId={message.author_agent_id} fallback={false} />{message.platform}</span>}
                </div>}
                <MessageTranslation key={JSON.stringify([message.edited_at, message.body, detail.room.access_mode, detail.room.directory_listed, user.id])} message={message} preview={Boolean(publicRoomId)}>
                {(displayBody, translationControl) => <><SwipeReply onReply={canSend ? () => { replyTo(message); composerInput.current?.focus({ preventScroll: true }); } : undefined}>
                {message.reply_to && <button type="button" className="reply-context" onClick={() => onFocus({
                  room: detail.room.id, message: message.reply_to!, replySeq: target?.seq ?? message.reply_seq ?? undefined,
                })}>
                  <span className="reply-caption"><Reply size={14} aria-hidden="true"/>{ui("返信先: ", "Reply to: ")}<bdi>{target ? authorName(target) : message.reply_author}</bdi></span>
                  <span className="reply-excerpt" dir="auto">{target?.body || message.reply_excerpt || ui("元のメッセージ", "Original message")}</span>
                </button>}
                {(message.sticker_id || !message.media_label_only) && <MessageBubble stickerOnly={Boolean(message.sticker_id && message.media_label_only)} onActions={canSend ? () => openActions(message) : undefined}>
                  {message.sticker_id && <Sticker id={message.sticker_id} />}
                  {!message.media_label_only && displayBody.split(/(@[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9-]+)?)/gi).map((part, i) => part.startsWith('@') ? <span className="mention" key={i}>{part}</span> : part)}
                </MessageBubble>}
                {Boolean(message.attachments?.length) && <div className="message-attachments">
                  {message.attachments?.map(file => <AttachmentView file={file} key={file.id} url={fileUrl(file)} onPhoto={() => setPhoto(file)} />)}
                </div>}
                <ReactionCounts items={message.reactions} onActions={canSend ? () => openActions(message) : undefined} />
                </SwipeReply>
                <div className="message-meta">
                  {canSend && Boolean(message.attachments?.length) && <button type="button" className="attachment-actions" aria-label={ui("メッセージの操作", "Message actions")} aria-haspopup="dialog" onClick={() => openActions(message)}><MoreHorizontal size={18} /></button>}
                  {translationControl}
                  <time dateTime={new Date(message.created_at).toISOString()}>{time(message.created_at)}</time>{message.edited_at && <span>{ui("編集済み", "Edited")}</span>}
                  {message.request_status && detail.room.directory_listed===1 && <a className="verification-marker" href={requestPath(message.id)} onClick={e=>followAppLink(e,requestPath(message.id))}>{message.request_status==='open'?ui('受付中の依頼','Open request'):ui('解決済みの依頼','Resolved request')}</a>}
                  {Boolean(message.has_note) && <button className="verification-marker" aria-haspopup="dialog" onClick={()=>setNoteMessage(message)}>{noteLabel}{Boolean(message.has_correction) && ui('・訂正あり',' · Corrected')}</button>}
                  {readCount > 0 && <span className="read-receipt">{group || readCount > 1 ? ui("既読", "Read") + readCount : ui("既読", "Read")}</span>}

                </div></>}
                </MessageTranslation>
              </div>
            </article>
          </div>;
        })}
        <div role="status">{preparing.length > 0 && <div className="reply-preparing">
          <span className="reply-faces" aria-hidden="true">{preparing.slice(0,4).map(p =>
            <Avatar key={(p.agent ? 'a' : 'u') + p.id} name={p.name} agent={p.agent} size="small" subjectId={p.id} />)}</span>
          {preparing.length > 4 && <small>+{preparing.length - 4}</small>}
          <span className="reply-dots" role="img" aria-label={preparing.map(p => p.name).join('、') + ui("が入力中", " typing")}><i /><i /><i /></span>
        </div>}</div>
      </div>
    </div>
    <div className="composer-area" ref={composerArea}>{!canSend ? <div className="guest-join"><div className="guest-join-actions">
      {(accountJoin || detail.room.access_mode === 'anonymous') && <button className="primary-button" disabled={joining} onClick={onJoin}>{joining ? ui("参加中…", "Joining…") : accountJoin ? ui("ルームに参加", "Join room") : ui("匿名で参加する", "Join anonymously")}</button>}
      {!accountJoin && <a className="outline-button" href={(location.origin === directoryOrigin ? directoryAppOrigin : '') + '/?login=1&next=' + encodeURIComponent(location.origin === directoryOrigin || new URLSearchParams(location.search).get('from') === 'public'
        ? directoryRoomPath(detail.room.id, 'public', new URLSearchParams(location.search).get('tag')) : '/rooms/' + detail.room.id)}>{ui("ログインして参加", "Sign in to join")}</a>}
    </div><small><a href="/terms">{ui("利用規約", "Terms of Service")}</a>{ui("に同意して参加します。", " apply when you join.")} <a href="/privacy">{ui("プライバシーポリシー", "Privacy Policy")}</a></small></div> :
      <form className="composer" onSubmit={submit}>
        {reply && <div className="reply-preview"><Reply size={16} /><span><strong>{authorName(reply)}{ui("に返信", " (reply)")}</strong>{reply.body}</span><button type="button" disabled={busy} aria-label={ui("返信をやめる", "Cancel reply")} onClick={() => setReply(null)}><X size={16} /></button></div>}
        <DraftTray files={files} sticker={sticker} disabled={busy} onRemove={index => setFiles(previous => previous.filter((_, i) => i !== index))} onRemoveSticker={() => setSticker(null)} />
        <div className="composer-line"><button type="button" className="add-button" aria-label={ui("添付とスタンプ", "Attachments and stickers")} aria-haspopup="dialog" disabled={busy} onClick={() => { setFileError(''); setSheet('attachments'); }}><Plus size={22} /></button><textarea readOnly={busy} ref={composerInput} onFocus={() => setComposerFocus(true)} onBlur={() => setComposerFocus(false)} value={body} onChange={(event) => setBody(event.target.value)} placeholder={ui("メッセージを入力", "Write a message")} maxLength={4000} rows={1} aria-label={ui("メッセージ", "Message")} onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
        }} /><button className="send-button" disabled={busy || !hasContent} aria-label={busy ? ui("送信中", "Sending") : ui("送信", "Send")} aria-busy={busy}><Send size={20} strokeWidth={1.9} /></button></div>
      </form>}
    </div>
    {focus !== reachedFocus.current && focus?.replySeq !== undefined && !targetLoaded && <p className="receipt-error" role="status">{needsReplyPage && (loadingOlder || replyPage.current?.focus !== focus || replyPage.current.cursor !== first.id) ? ui("返信先を読み込み中…", "Loading original message…") : ui("返信先を表示できません。", "Original message unavailable.")}</p>}
    {readError && <p className="receipt-error" role="status">{readError}</p>}
    {requestMessage && <RequestEditor message={requestMessage} guest={Boolean(publicRoomId)} csrf={guestCsrf} onSaved={refreshHistory} onClose={()=>setRequestMessage(null)}/>}
    {noteMessage && <VerificationDialog key={noteMessage.id} message={noteMessage} userId={user.id} canSend={canSend} listed={Boolean(detail.room.directory_listed)}
      publicView={Boolean(publicRoomId)} csrf={guestCsrf} onChange={refreshHistory} onClose={()=>setNoteMessage(null)}/>}
    {membershipEvent && <ParticipantProfile key={membershipEvent.id + ':' + (membershipEvent.member_agent_id ?? '')} room={detail.room.id} event={membershipEvent} publicView={Boolean(publicRoomId)} onClose={() => setMembershipEventId(null)} />}
    {profile && <ParticipantProfile key={profile.kind + profile.id} room={detail.room.id} subject={profile} publicView={Boolean(publicRoomId)} onClose={closeProfile} onRename={onAgentChanged} />}
    {sheet === 'attachments' && <Modal title={ui("ライブラリ", "Library")} onClose={() => setSheet(null)}>
      <AttachmentSheet error={fileError} onFiles={addFiles} onStickers={() => setSheet('stickers')} onMention={mentionable.length ? () => { setSheet(null); startMention(); } : undefined} />
    </Modal>}
    {sheet === 'stickers' && <Modal title={ui("スタンプ", "Stickers")} onClose={() => setSheet(null)}>
      <StickerPicker onSelect={id => { setSticker(id); setSheet(null); }} />
    </Modal>}
    {photo && <Modal title={ui("写真", "Photo")} onClose={() => setPhoto(null)}><div className="photo-viewer">
      <img src={fileUrl(photo)} alt={photo.name} /><a href={fileUrl(photo) + '?download'} download={photo.name}><Download size={17} />{ui("写真を保存", "Save photo")}</a>
    </div></Modal>}
    {picking && <Modal title={ui("メンション", "Mention")} onClose={() => setPicking(false)}><div className="picker-list">
      <ScrollItems items={mentionable}>{member => <button className="menu-agent" key={member.id} onClick={() => insertMention(member)}>
        <Avatar name={member.agent_name || member.display_name || member.account_name} agent={member.kind === 'agent'} subjectId={member.agent_id || member.user_id} />
        <span><strong>{member.agent_name || member.display_name || member.account_name}</strong><small>@{member.account_name}{member.kind === 'agent' && '/' + member.handle}</small></span>
      </button>}</ScrollItems>{actionError && <p className="form-error" role="alert">{actionError}</p>}
    </div></Modal>}
    {selected && <Modal title={ui("メッセージの操作", "Message actions")} onClose={() => setActionId(null)}>
      <ReactionPicker current={selected.reactions} busy={reacting} onChoose={emoji => void chooseReaction(emoji)} />
      <p className="action-excerpt">{selected.body}</p><div className="action-list">
        <button className="menu-action" onClick={() => action(() => replyTo(selected))}><Reply size={18} />{ui("返信", "Reply")}</button>
        <button className="menu-action" onClick={() => void copyMessage(selected)}><Copy size={18} />{ui("コピー", "Copy")}</button>
        {Boolean(detail.room.directory_listed) && detail.room.access_mode!=='invite' && selected.author_user_id===user.id && !selected.author_agent_id &&
          <button className="menu-action" onClick={()=>action(()=>setRequestMessage(selected))}>{selected.request_status?ui('依頼を編集','Edit request'):ui('依頼として公開','Publish as a request')}</button>}
        {((selected.author_user_id===user.id && !selected.author_agent_id) || Boolean(selected.has_note)) &&
          <button className="menu-action" onClick={()=>action(()=>setNoteMessage(selected))}>{noteLabel}</button>}
        {selected.reply_to && selected.author_user_id===user.id && !selected.author_agent_id &&
          Boolean(repliedTo?.has_note) && repliedTo?.author_user_id===user.id && !repliedTo.author_agent_id &&
          <button className="menu-action" onClick={async()=>{
            if (!selected.reply_to) return;
            const path='/rooms/'+encodeURIComponent(detail.room.id)+'/messages/'+encodeURIComponent(selected.reply_to)+'/note';
            try { await (publicRoomId?publicRequest:request)(path,{method:'PUT',csrf:guestCsrf,body:{kind:'correction',reply_id:selected.id}});
              setActionId(null);refreshHistory();
            } catch(e){setActionError(e instanceof Error ? e.message : ui('保存できませんでした。','Could not save.'));}
          }}>{ui('元のノートの訂正にする','Mark as correction')}</button>}
        {selected.attachments?.filter(file => file.kind === 'video').map(file => <a key={file.id} className="menu-action" href={fileUrl(file) + '?download'} download={file.name}><Download size={18} />{file.name}{ui("を保存", " (save)")}</a>)}
        {actionError && <p className="form-error" role="alert">{actionError}</p>}
        {selected.author_user_id === user.id ? <>
          {onEdit && <button className="menu-action" onClick={() => action(() => { const text = window.prompt(ui("メッセージを編集", "Edit message"), selected.body); if (text !== null) onEdit(selected, text); })}><Pencil size={18} />{ui("編集", "Edit")}</button>}
          {onDelete && <button className="menu-action destructive" onClick={() => action(() => { if (window.confirm(ui("このメッセージを削除しますか？", "Delete this message?"))) onDelete(selected); })}><Trash2 size={18} />{ui("削除", "Delete")}</button>}
        </> : <>
          {onReport && <button className="menu-action" onClick={() => action(() => onReport(selected))}><Flag size={18} />{ui("通報", "Report")}</button>}
          {onBlock && !selected.is_guest && <button className="menu-action destructive" onClick={() => action(() => onBlock(selected))}><Ban size={18} />{ui("ブロック", "Block")}</button>}
        </>}
      </div>
    </Modal>}
  </section>;
}

type PublicRoomSummary = { directory_listed: number; id: string; name: string; description: string; access_mode: AccessMode; host_account: string };
type GuestSession = { active: false } | { active: true; user_id: string; display_name: string; csrf: string };
type PublicImage = { kind: ImageKind; subject_id: string; updated_at: number };

export function PublicChat({ roomId, onBack, onLogin, onAccountJoin }: { roomId: string; onBack: () => void; onLogin: () => void; onAccountJoin?: () => Promise<void> }) {
  const [room, setRoom] = useState<Room | null>(null); const [timeline, setTimeline] = useState(emptyTimeline); const [guest, setGuest] = useState<GuestSession>({ active: false });
  const [images, setImages] = useState<ImageVersions>({}); const [error, setError] = useState(''); const [unavailable, setUnavailable] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false); const [joining, setJoining] = useState(false);
  const [focus, setFocus] = useState<MessageFocus | null>(linkedMessage);
  const [showInfo, setShowInfo] = useState(false);
  const [guestDialog,setGuestDialog] = useState<'join' | 'leave' | 'profile' | null>(null);
  const [guestName,setGuestName] = useState(ui("匿名", "Anonymous")), [dialogError,setDialogError] = useState('');
  const [leaving,setLeaving] = useState(false);
  const guestRevision = useRef(0);
  const [photo,setPhoto] = useState<ProfilePhoto | null>(null);
  function openJoin() {
    setPhoto(null);
    setGuestName(rememberedGuestName()); setDialogError(''); setGuestDialog('join');
  }
  const path = `/rooms/${encodeURIComponent(roomId)}`;
  const refreshImages = useCallback(async () => { const data = await publicRequest<{ images: PublicImage[] }>(`${path}/images`); setImages(Object.fromEntries(data.images.map((item) => [`${item.kind}:${item.subject_id}`, item.updated_at]))); }, [path]);
  const load = useCallback(async () => {
    const revision = guestRevision.current;
    const [roomData, history, session, imageData] = await Promise.all([
      publicRequest<{ room: Room }>(path), publicRequest<TimelinePage>(timelinePath(roomId)),
      publicRequest<GuestSession>(`${path}/session`), publicRequest<{ images: PublicImage[] }>(`${path}/images`),
    ]);
    if (revision !== guestRevision.current) return;
    setRoom(roomData.room); setGuest(session); setImages(Object.fromEntries(imageData.images.map((item) => [`${item.kind}:${item.subject_id}`, item.updated_at])));
    setTimeline(previous => updateTimeline(previous, history));
    setError(''); setUnavailable(false);
  }, [path, roomId]);
  useEffect(() => {
    let active = true;
    const update = () => void load().catch((cause) => { if (!active) return; if (cause instanceof ApiError && cause.status === 404) { setUnavailable(true); setRoom(null); setTimeline(emptyTimeline); setShowInfo(false); } else setError(cause instanceof Error ? cause.message : ui("読み込めませんでした。", "Could not load.")); });
    update(); const timer = window.setInterval(update, 20_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [load]);
  async function join() {
    setJoining(true); setError('');
    try {
      const result = await publicRequest<Extract<GuestSession,{active:true}> & {image_version?: number}>(`${path}/session`, { method: 'POST', body: {display_name: guestName.trim(), image: photo ?? undefined} });
      if (result.image_version) setImages(previous => ({...previous,['user:'+result.user_id]: result.image_version!}));
      guestRevision.current++; setGuest(result); setGuestDialog(null);
      rememberGuestName(result.display_name);
    }
    catch (cause) { setDialogError(cause instanceof Error ? cause.message : ui("参加できませんでした。", "Could not join.")); }
    finally { setJoining(false); }
  }
  async function saveProfile() {
    if (!guest.active) return;
    setJoining(true); setDialogError('');
    try {
      const saved = await publicRequest<{display_name: string; image_version: number | null}>(path + '/session/profile', {
        method: 'PATCH', csrf: guest.csrf, body: { display_name: guestName.trim(), image: photo ?? undefined },
      });
      guestRevision.current++;
      setGuest({ ...guest, display_name: saved.display_name });
      if (saved.image_version) setImages(previous => ({ ...previous, ['user:' + guest.user_id]: saved.image_version! }));
      if (room?.host_user_id === guest.user_id) setRoom({ ...room, host_display_name: saved.display_name });
      rememberGuestName(saved.display_name);
      setGuestDialog(null);
    } catch (cause) { setDialogError(cause instanceof Error ? cause.message : ui("保存できませんでした。", "Could not save your profile.")); }
    finally { setJoining(false); }
  }
  async function leave() {
    if (!guest.active || leaving) return;
    setLeaving(true); setDialogError('');
    try { await publicRequest(`${path}/session/end`, { method: 'POST', csrf: guest.csrf }); guestRevision.current++; setGuest({ active: false }); setGuestDialog(null); }
    catch (cause) { setDialogError(cause instanceof Error ? cause.message : ui("退室できませんでした。", "Could not leave the room.")); }
    finally { setLeaving(false); }
  }
  async function react(message: Message, emoji: string | null) {
    if (!guest.active) throw new Error(ui("ルームに参加してください。", "Join the room first."));
    const result = await publicRequest<{ reactions: Reaction[] }>(`${path}/messages/${message.id}/reaction`, { method: 'PUT', csrf: guest.csrf, body: { emoji } });
    setTimeline(previous => ({ ...previous, items: previous.items.map(m => m.id === message.id ? { ...m, reactions: result.reactions } : m) }));
  }
  async function send(text: string, replyTo: string | null, media?: MediaDraft): Promise<boolean> {
    if (!guest.active) return false;
    const post = chatPost(text, replyTo, media);
    try { await publicRequest(path + post.path, { method: 'POST', csrf: guest.csrf, body: post.body }); await load(); return true; }
    catch (cause) { setError(cause instanceof Error ? cause.message : ui("送信できませんでした。", "Could not send.")); return false; }
  }
  async function older() {
    const before = timeline.items[0];
    if (!before) return;
    setLoadingOlder(true);
    try {
      const page = await publicRequest<TimelinePage>(timelinePath(roomId, before));
      setTimeline(previous => prependTimeline(previous, page, before));
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : ui("履歴を読み込めませんでした。", "Could not load the history.")); }
    finally { setLoadingOlder(false); }
  }
  async function report(message: Message) {
    if (!guest.active) return; const reason = window.prompt(ui("通報する理由を入力してください。", "Why are you reporting this message?")); if (!reason?.trim()) return;
    try { await publicRequest(`${path}/reports`, { method: 'POST', csrf: guest.csrf, body: { message_id: message.id, reason } }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : ui("通報できませんでした。", "Could not submit the report.")); }
  }
  return <ImageContext.Provider value={{ images, refresh: refreshImages, publicRoomId: roomId }}><div className="app-shell reading-room">
    <header className="app-bar"><div className="app-bar-inner">
      <button className="toolbar-button back-to-rooms" aria-label={ui("公開ルーム一覧", "Public rooms")} onClick={onBack}><ChevronLeft size={24} /></button>
      <button className="room-switch" aria-label={ui("ルームの詳細", "Room details")} disabled={!room} onClick={() => setShowInfo(true)}>
        {room && <RoomFaces room={room} />}<span className="room-switch-copy"><strong>{room?.name || ui("ルーム", "Rooms")}</strong><small>{guest.active ? (guest.display_name || ui("匿名", "Anonymous")) + ui("で参加中", " (joined)") : ui("閲覧中", "Viewing")}</small></span>
      </button><div className="toolbar-actions">{room?.access_mode === 'anonymous' && room.id === introRoomId && <IntroAgentInvite/>} {guest.active && <><button className="toolbar-button" aria-label={ui("自分のプロフィールを編集", "Edit my profile")} onClick={() => {
        setPhoto(null); setGuestName(guest.display_name); setDialogError(''); setGuestDialog('profile');
      }}><Avatar name={guest.display_name} size="small" subjectId={guest.user_id} /></button><button className="toolbar-button" aria-label={ui("退室", "Leave")} title={ui("退室", "Leave")} onClick={() => {setDialogError(''); setGuestDialog('leave');}}><LogOut size={19} /></button></>}</div>
    </div></header>
    {(guestDialog === 'join' || (guestDialog === 'profile' && guest.active)) && <Modal
      title={guestDialog === 'join' ? ui("匿名で参加", "Join anonymously") : ui("自分のプロフィール", "My profile")}
      closeDisabled={joining} onClose={() => setGuestDialog(null)}>
      <GuestProfileForm name={guestName} onName={setGuestName} photo={photo} onPhoto={setPhoto} subjectId={guest.active ? guest.user_id : undefined}
        busy={joining} error={dialogError} onBack={() => setGuestDialog(null)}
        submitLabel={guestDialog === 'join' ? ui("参加する", "Join") : ui("保存", "Save")} onSubmit={guestDialog === 'join' ? join : saveProfile}/>
    </Modal>}
    {guestDialog === 'leave' && <Modal title={ui("このルームから退室しますか？", "Leave this room?")} closeDisabled={leaving} onClose={() => setGuestDialog(null)}>
      <div className="detail-section confirmation-body">
        {dialogError && <p className="form-error" role="alert">{dialogError}</p>}
        <div className="dialog-actions">
          <button className="outline-button" disabled={leaving} onClick={() => setGuestDialog(null)}>{ui("キャンセル", "Cancel")}</button>
          <button className="primary-button" disabled={leaving} onClick={() => void leave()}>{ui("退室する", "Leave room")}</button>
        </div>
      </div>
    </Modal>}
    {guest.active && !unavailable && <MessageToast key={guest.user_id} path={'/public' + path + '/inbox'} onIncoming={() => void load().catch(cause => setError(String(cause)))}
      onOpen={m => { setShowInfo(false); setFocus({ room: roomId, message: m.id }); }} />}
    {showInfo && room && <Modal title={room.name} onClose={() => setShowInfo(false)}><div className="detail-section"><p>{ui("主催", "Hosted by")} {room.host_display_name || room.host_account} · {accessLabel(room.access_mode)}</p>{room.description && <p>{room.description}</p>}</div>{room.access_mode === 'anonymous' && <GuestAgentLink roomId={room.id} />}</Modal>}
    <main className="main-panel">{error && <div className="global-error" role="alert"><span>{error}</span><button aria-label={ui("閉じる", "Close")} onClick={() => setError('')}><X size={16} /></button></div>}{unavailable ? <div className="welcome-panel"><h1>{ui("ルームを開けません", "Room unavailable")}</h1><p>{ui("参加にはログインまたは招待が必要な場合があります。", "You may need to sign in or receive an invitation.")}</p><button className="outline-button" onClick={onAccountJoin ? onBack : onLogin}>{onAccountJoin ? ui("戻る", "Back") : ui("ログイン", "Sign in")}</button></div> : room ? <Chat key={room.id} focus={focus} onFocus={setFocus} refreshHistory={() => void load().catch(cause => setError(String(cause)))} user={{ id: guest.active ? guest.user_id : '', account_name: ui("匿名", "Anonymous"), display_name: guest.active ? guest.display_name : null, email: '' }} detail={{ room, members: [] }} items={timeline.items} hasOlder={timeline.has_more} loadingOlder={loadingOlder} onOlder={() => void older()} onSend={send} onReact={react} guestCsrf={guest.active ? guest.csrf : undefined} canSend={guest.active} accountJoin={Boolean(onAccountJoin)} onJoin={onAccountJoin ? () => { setJoining(true); void onAccountJoin().catch(cause => setError(cause.message)).finally(() => setJoining(false)); } : openJoin} joining={joining} onReport={guest.active ? (message) => void report(message) : undefined} /> : <div className="loading-screen">{ui("読み込み中…", "Loading…")}</div>}</main></div></ImageContext.Provider>;
}

function hostListUrl() {
  const host = new URLSearchParams(location.search).get('host_list');
  return isAccountOrigin(location.origin) && host && /^[a-z0-9-]{3,32}$/.test(host)
    ? 'https://' + host + '.a2aroom.com/' + (new URLSearchParams(location.search).get('from') === 'host-inbox' ? 'inbox' : '') : null;
}

function PublicApp({ initialRoom, onLogin }: { initialRoom: string | null; onLogin: () => void }) {
  const [roomId, setRoomId] = useState(initialRoom);
  useEffect(() => { const listener = () => setRoomId(location.pathname.match(/^\/rooms\/([^/]+)/)?.[1] ?? null); window.addEventListener('popstate', listener); return () => window.removeEventListener('popstate', listener); }, []);
  const directoryUrl = publicRoomsUrl(location.origin, location.search);
  const redirectHome = !roomId && location.pathname === '/' && location.origin === directoryAppOrigin;
  useEffect(() => {
    if (redirectHome) location.replace(directoryUrl);
  }, [redirectHome, directoryUrl]);
  if (location.pathname === '/new-room') return <GuestRoomForm/>;
  if (redirectHome) return null;
  function back() { if (history.state?.fromAppPage) history.back(); else navigateWithinApp(hostListUrl() ?? roomDirectoryReturn(location.origin, location.search) ?? directoryUrl, true); }
  if (roomId) return <PublicChat key={roomId} roomId={roomId} onBack={back} onLogin={onLogin} />;
  return <PublicHome onLogin={onLogin}/>;
}

export function App() {
  const [session, setSession] = useState<SessionResponse | null>(null); const [tab, setTab] = useState<Tab>(() => tabFromPath(location.pathname));
  const [accountSection, setAccountSection] = useState<AccountSection | null>(() => accountSectionFromPath(location.pathname));
  const [rooms, setRooms] = useState<InboxRoom[]>([]); const [agents, setAgents] = useState<Agent[]>([]); const [connections, setConnections] = useState<Connection[]>([]); const [notifications, setNotifications] = useState<Notice[]>([]);
  const [roomsLoaded, setRoomsLoaded] = useState(false);
  const [images, setImages] = useState<ImageVersions>({});
  const [showLogin, setShowLogin] = useState(location.pathname === '/inbox' || location.pathname === '/account/profile' || new URLSearchParams(location.search).get('login') === '1' || Boolean(new URLSearchParams(location.search).get('next')) || /^\/invite\/[^/]+/.test(location.pathname));
  const [joinCandidate, setJoinCandidate] = useState<PublicRoomSummary | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null); const [selectedAgent, setSelectedAgent] = useState<string | null>(() => agentIdFromPath(location.pathname)); const [addingAgent, setAddingAgent] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const toolbarRef = useRef<HTMLElement>(null);
  const [activeId, setActiveId] = useState<string | null>(() => location.pathname.match(/^\/rooms\/([^/]+)/)?.[1] ?? null);
  const [inviteCode, setInviteCode] = useState<string | null>(() => location.pathname.match(/^\/invite\/([^/]+)/)?.[1] ?? null);
  const [detail, setDetail] = useState<RoomDetail | null>(null); const [timeline, setTimeline] = useState(emptyTimeline); const [newRoom, setNewRoom] = useState(() => location.pathname === '/inbox' && new URLSearchParams(location.search).get('compose') === '1'); const [membersOpen, setMembersOpen] = useState<'メンバー' | 'トーク設定' | null>(null); const [error, setError] = useState('');
  const jumpGeneration = useRef(0);
  const [focus, setFocus] = useState<MessageFocus | null>(linkedMessage);
  function cancelJump() { jumpGeneration.current++; setFocus(null); }
  const [loadingOlder, setLoadingOlder] = useState(false);
  const activeRoomRef = useRef(activeId); const roomRequest = useRef(0); const appliedRoomRequest = useRef(0);
  const user = session?.authenticated ? session.user : null;
  const publicAccess = Boolean(session?.authenticated && session.publicAccess);

  const loadSession = useCallback(async () => { try { const result = await browserSession(); setSession(result); if (result.authenticated) setCsrf(result.csrf); } catch (cause) { setError(cause instanceof Error ? cause.message : ui("読み込めませんでした。", "Could not load.")); } }, []);
  const roomsRequest = useRef(0);
  const loadRooms = useCallback(async () => {
    const sequence = ++roomsRequest.current;
    const result = await request<{ rooms: InboxRoom[] }>('/rooms?offset=0');
    if (sequence === roomsRequest.current) { setRooms(result.rooms); setRoomsLoaded(true); }
  }, []);
  const loadAgents = useCallback(async () => { const result = await request<{ agents: Agent[]; connections: Connection[] }>('/agents'); setAgents(result.agents); setConnections(result.connections); }, []);
  const loadImages = useCallback(async () => { const result = await request<{ images: Array<{ kind: ImageKind; subject_id: string; updated_at: number }> }>('/images'); setImages(Object.fromEntries(result.images.map((item) => [`${item.kind}:${item.subject_id}`, item.updated_at]))); }, []);
  const noticeRequest = useRef(0);
  const loadNotifications = useCallback(async () => {
    const sequence = ++noticeRequest.current;
    const result = await request<{ notifications: Notice[] }>('/notifications?offset=0');
    if (sequence === noticeRequest.current) setNotifications(result.notifications);
  }, []);
  function applyRoomSettings(id: string, patch: RoomSettingsPatch) {
    ++roomsRequest.current;
    setRooms(previous => previous.map(room => room.id === id ? { ...room, ...patch } : room));
    if (activeRoomRef.current !== id) return;
    appliedRoomRequest.current = ++roomRequest.current;
    setDetail(previous => previous?.room.id === id ? { ...previous, room: { ...previous.room, ...patch } } : previous);
  }
  function agentRenamed(roomId: string, id: string, name: string) {
    if (activeRoomRef.current !== roomId) return;
    appliedRoomRequest.current = ++roomRequest.current;
    setDetail(previous => previous?.room.id === roomId ? {
      ...previous, members: previous.members.map(member => member.agent_id === id ? { ...member, agent_name: name } : member),
    } : previous);
    run(Promise.all([loadAgents(), loadRoom(roomId)]));
  }
  const loadRoom = useCallback(async (id: string) => {
    const sequence = ++roomRequest.current;
    let room: RoomDetail; let data: TimelinePage;
    try { [room, data] = await Promise.all([request<RoomDetail>(`/rooms/${id}`), request<TimelinePage>(timelinePath(id))]); }
    catch (cause) {
      if (cause instanceof ApiError && [403,404].includes(cause.status) && activeRoomRef.current === id && sequence >= appliedRoomRequest.current) {
        appliedRoomRequest.current = sequence; setDetail(null); setMembersOpen(null); setTimeline(emptyTimeline); setJoinCandidate(null);
      }
      if (publicAccess && cause instanceof ApiError && cause.status === 403) {
        const directory = await request<{ room: PublicRoomSummary }>(`/directory/rooms/${encodeURIComponent(id)}`);
        const candidate = directory.room;
        if (candidate && activeRoomRef.current === id && sequence >= appliedRoomRequest.current) { appliedRoomRequest.current = sequence; setJoinCandidate(candidate); setDetail(null); return; }
      }
      throw cause;
    }
    if (activeRoomRef.current !== id || sequence < appliedRoomRequest.current) return;
    appliedRoomRequest.current = sequence;
    setJoinCandidate(null); setDetail(room); setTimeline(previous => updateTimeline(previous, data));
    const last = data.items.filter(isMessage).at(-1);
    if (last) await request(`/rooms/${id}/read`, { method: 'POST', body: { message_id: last.id } });
    await loadRooms();
  }, [publicAccess, loadRooms]);
  const run = useCallback((promise: Promise<unknown>) => { void promise.catch((cause) => setError(cause instanceof Error ? cause.message : ui("処理できませんでした。", "Could not complete the action."))); }, []);
  useEffect(() => { void loadSession(); }, [loadSession]);
  const refreshNotices = useCallback(() => run(loadNotifications()), [run, loadNotifications]);
  useEffect(() => { if (user) { run(Promise.all([loadAgents(), loadNotifications(), loadImages()])); } }, [user?.id, loadAgents, loadNotifications, loadImages, run]);
  useEffect(() => { if (!user) return; const timer = window.setInterval(() => run(Promise.all([loadNotifications(), loadImages()])), 30_000); return () => window.clearInterval(timer); }, [user?.id, loadNotifications, loadImages, run]);
  useEffect(() => {
    if (!user || tab !== 'rooms' || activeId) return;
    run(loadRooms());
    const timer = window.setInterval(() => run(loadRooms()), 20_000);
    return () => window.clearInterval(timer);
  }, [user?.id, tab, activeId, loadRooms, run]);
  useEffect(() => { if (!user || !activeId || tab !== 'rooms' || joinCandidate?.id === activeId) return; run(loadRoom(activeId)); const timer = window.setInterval(() => run(loadRoom(activeId)), 20_000); return () => window.clearInterval(timer); }, [user?.id, activeId, tab, joinCandidate?.id, loadRoom, run]);
  useEffect(() => { const listener = () => { cancelJump(); const nextId = location.pathname.match(/^\/rooms\/([^/]+)/)?.[1] ?? null; if (activeRoomRef.current !== nextId) setTimeline(emptyTimeline); activeRoomRef.current = nextId; setActiveId(nextId); setInviteCode(location.pathname.match(/^\/invite\/([^/]+)/)?.[1] ?? null); setAccountSection(accountSectionFromPath(location.pathname)); setSelectedAgent(agentIdFromPath(location.pathname)); setMembersOpen(null); setNewRoom(false); setAddingAgent(false); setError(''); setTab(tabFromPath(location.pathname)); setMenu(null); }; window.addEventListener('popstate', listener); return () => window.removeEventListener('popstate', listener); }, []);
  useEffect(() => {
    if (!menu) return;
    toolbarRef.current?.querySelector<HTMLButtonElement>(`#menu-${menu} button`)?.focus({ preventScroll: true });
    const onPointerDown = (event: PointerEvent) => { if (!toolbarRef.current?.contains(event.target as Node)) setMenu(null); };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenu(null);
        const trigger = toolbarRef.current?.querySelector<HTMLButtonElement>(`[aria-expanded][aria-controls="menu-${menu}"]`)
          ?? toolbarRef.current?.querySelector<HTMLButtonElement>('[aria-controls="menu-account"]');
        trigger?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointerDown); document.addEventListener('keydown', onKeyDown);
    return () => { document.removeEventListener('pointerdown', onPointerDown); document.removeEventListener('keydown', onKeyDown); };
  }, [menu]);
  function openRoom(id: string) { cancelJump();
    setMenu(null); setError(''); setInviteCode(null);
    if (id === activeId && tab === 'rooms') {
      if (location.pathname !== `/rooms/${id}`) history.pushState({ fromInbox: location.pathname === '/inbox' }, '', `/rooms/${id}`);
      if (detail?.room.id !== id) run(loadRoom(id));
      return;
    }
    activeRoomRef.current = id; setTab('rooms'); setActiveId(id); setJoinCandidate(null); setDetail(null); setTimeline(emptyTimeline); history.pushState({ fromInbox: location.pathname === '/inbox' }, '', `/rooms/${id}`);
  }
  function navigatePage(path: string) {
    navigateWithinApp(path);
  }
  function openInbox() { cancelJump();
    setMenu(null); setError(''); setMembersOpen(null);
    const returnUrl = hostListUrl() ?? roomDirectoryReturn(location.origin, location.search);
    if (history.state?.fromAppPage) { history.back(); return; }
    if (returnUrl) { navigateWithinApp(returnUrl, true); return; }
    if (history.state?.fromInbox) { history.back(); return; }
    activeRoomRef.current = null;
    setActiveId(null); setInviteCode(null); setDetail(null); setJoinCandidate(null); setTab('rooms');
    if (location.pathname !== '/inbox') history.pushState(null, '', '/inbox');
  }
  function openAgent(id: string | null) { cancelJump();
    if (!id && history.state?.fromAgentList) { history.back(); return; }
    setSelectedAgent(id); setMenu(null); setError(''); setTab('agents');
    const path = id ? '/agents/' + encodeURIComponent(id) : '/agents';
    if (location.pathname !== path) history.pushState({ fromInbox: location.pathname === '/inbox', fromSettings: location.pathname === '/account', fromAgentList: location.pathname === '/agents' }, '', path);
  }
  function selectTab(next: Tab) { cancelJump(); setMenu(null); setTab(next); setError(''); if (next === 'account') setAccountSection(null); if (next !== 'rooms') history.pushState({ fromAppPage: true, fromInbox: location.pathname === '/inbox' }, '', `/${next}`); else history.pushState(null, '', activeId ? `/rooms/${activeId}` : '/inbox'); }
  function openAccountSection(section: AccountSection) { setAccountSection(section); history.pushState({ fromAccountSettings: true }, '', `/account/${section}`); }
  function closeAccountSection() {
    if (history.state?.fromAccountSettings || history.state?.fromAppPage) history.back();
    else { history.replaceState(null, '', '/account'); setAccountSection(null); }
  }
  async function joinPublicRoom(id: string) { try { await request(`/rooms/${encodeURIComponent(id)}/join`, { method: 'POST' }); setJoinCandidate(null); await Promise.all([loadRoom(id), loadRooms(), loadImages()]); } catch (cause) { setError(cause instanceof Error ? cause.message : ui("参加できませんでした。", "Could not join.")); } }
  async function react(message: Message, emoji: string | null) {
    const result = await request<{ reactions: Reaction[] }>(`/rooms/${message.room_id}/messages/${message.id}/reaction`, { method: 'PUT', body: { emoji } });
    setTimeline(previous => ({ ...previous, items: previous.items.map(m => m.id === message.id ? { ...m, reactions: result.reactions } : m) }));
  }
  async function send(body: string, replyTo: string | null, media?: MediaDraft): Promise<boolean> {
    if (!activeId) return false;
    setError('');
    const post = chatPost(body, replyTo, media);
    try { await request(`/rooms/${activeId}` + post.path, { method: 'POST', body: post.body }); await loadRoom(activeId); return true; } catch (cause) { setError(cause instanceof Error ? cause.message : ui("送信できませんでした。", "Could not send.")); return false; } }
  async function modify(message: Message, body?: string) { try { await request(`/messages/${message.id}`, body === undefined ? { method: 'DELETE' } : { method: 'PATCH', body: { body } }); if (activeId) await loadRoom(activeId); await loadRooms(); } catch (cause) { setError(cause instanceof Error ? cause.message : ui("変更できませんでした。", "Could not save changes.")); } }
  async function report(message: Message) { const reason = window.prompt(ui("通報する理由を入力してください。", "Why are you reporting this message?")); if (!reason?.trim()) return; try { await request('/reports', { method: 'POST', body: { message_id: message.id, reason } }); } catch (cause) { setError(cause instanceof Error ? cause.message : ui("通報できませんでした。", "Could not submit the report.")); } }
  async function block(message: Message) { if (!window.confirm(ui(`${message.account_name}をブロックしますか？ お互いの発言が見えなくなります。`, `Block ${message.account_name}? Your messages will be hidden from each other.`))) return; try { await request('/blocks', { method: 'POST', body: { account_name: message.account_name } }); setTimeline(emptyTimeline); if (activeId) await loadRoom(activeId); await Promise.all([loadRooms(), loadNotifications(), loadImages()]); } catch (cause) { setError(cause instanceof Error ? cause.message : ui("ブロックできませんでした。", "Could not block the account.")); } }
  async function loadOlder() {
    const before = timeline.items[0];
    if (!activeId || !before) return;
    const id = activeId;
    setLoadingOlder(true);
    try {
      const page = await request<TimelinePage>(timelinePath(id, before));
      if (activeRoomRef.current === id) setTimeline(previous => prependTimeline(previous, page, before));
    } catch (cause) { setError(cause instanceof Error ? cause.message : ui("履歴を読み込めませんでした。", "Could not load the history.")); }
    finally { setLoadingOlder(false); }
  }
  async function logout() {
    cancelJump();
    await request('/logout', { method: 'POST' });
    setCsrf('');
    if (location.origin === directoryOrigin) { navigateWithinApp('/', true); return; }
    if (isAccountOrigin(location.origin)) { location.replace(publicRoomsUrl(location.origin)); return; }
    setConfirmLogout(false);
    setSession({ authenticated: false, needsSetup: false, publicAccess });
    activeRoomRef.current = null;
    setActiveId(null); setInviteCode(null); setDetail(null); setJoinCandidate(null); setTimeline(emptyTimeline);
    roomsRequest.current++;
    setRooms([]); setRoomsLoaded(false); setAgents([]); setConnections([]); setNotifications([]); setImages({});
    setSelectedAgent(null); setShowLogin(false); setTab('rooms');
    history.replaceState(null, '', '/');
  }
  if (!session) return <div className="loading-screen"><span>{ui("読み込み中…", "Loading…")}</span>{error && <p role="alert">{error}</p>}</div>;
  const registration = registrationFromSearch(location.search);
  if (!session.authenticated && registration) return <RegistrationConfirmation {...registration} />;
  if (!session.authenticated) return session.publicAccess && !session.needsSetup && !showLogin ? <PublicApp initialRoom={activeId} onLogin={() => { const roomId = location.pathname.match(/^\/rooms\/([^/]+)/)?.[1] ?? null; activeRoomRef.current = roomId; setActiveId(roomId); setShowLogin(true); }} /> : <AuthView />;
  const selected = rooms.find((room) => room.id === activeId);
  const currentDetail = tab === 'rooms' && detail?.room.id === activeId ? detail : null;
  const inRoom = tab === 'rooms' && Boolean(activeId) && !inviteCode;
  const atInbox = tab === 'rooms' && !activeId && !inviteCode;
  const currentRoom = selected ?? currentDetail?.room;
  const unreadNotices = notifications.some((notice) => !notice.read_at);
  async function openNotice(item: Notice) {
    const markRead = () => run(request(`/notifications/${item.id}/read`, { method: 'POST' }).then(loadNotifications));
    if (item.kind !== 'reply') markRead();
    const room = item.room_id;
    if (!room) { setMenu(null); return; }
    const message = item.source_message_id;
    if (!message) { setMenu(null); setError(ui("この通知の発言は表示できません。", "This message is unavailable.")); return; }
    await openMessage(room, message, item.source_seq, item.kind === 'reply' ? markRead : undefined);
  }
  async function openMessage(room: string, message: string, seq: number | null, found?: () => void) {
    setMembersOpen(null); setNewRoom(false); setAddingAgent(false); setConfirmLogout(false);
    openRoom(room);
    const generation = jumpGeneration.current;
    const fetched: TimelineItem[][] = [];
    let revision: number | undefined;
    let before: TimelineItem | undefined;
    try {
      do {
        const page = await request<TimelinePage>(timelinePath(room, before));
        if (generation !== jumpGeneration.current || activeRoomRef.current !== room) return;
        if (revision !== undefined && revision !== page.moderation_revision) { setError(ui("会話が更新されました。もう一度開いてください。", "The conversation changed. Open it again.")); return; }
        revision = page.moderation_revision;
        fetched.push(page.items);
        if (page.items.some(item => item.id === message)) {
          const items = fetched.reverse().flat();
          setTimeline(previous => {
            const last = items[items.length - 1];
            const end = previous.items.findIndex(item => item.room_id === room && item.id === last.id);
            const loaded = updateTimeline(previous, { ...page, items });
            return end < 0 || previous.moderation_revision !== page.moderation_revision ? loaded : { ...loaded, items: [...loaded.items, ...previous.items.slice(end + 1)] };
          });
          setFocus({ room, message });
          found?.();
          return;
        }
        const first: TimelineItem | undefined = page.items[0];
        // Events with the target's anchor sequence follow that message.
        before = page.has_more && first && (seq === null || first.seq > seq || (first.seq === seq && !isMessage(first))) ? first : undefined;
      } while (before);
      setError(ui("この通知の発言は表示できません。", "This message is unavailable."));
    } catch (cause) {
      if (generation === jumpGeneration.current) setError(cause instanceof Error ? cause.message : ui("発言を読み込めませんでした。", "Could not load this message."));
    }
  }
  const toggleMenu = (next: Menu) => setMenu(menu === next ? null : next);
  const createRoom = () => { setMenu(null); setNewRoom(true); };
  const addAgent = () => { setMenu(null); setAddingAgent(true); };
  const accountButton = <><button type="button" className="toolbar-button" aria-label={ui("プロフィール","My profile")} onClick={() => navigatePage('/account/profile')}><Avatar name={session.user.account_name} subjectId={session.user.id} size="small"/></button><button type="button" className={'account-trigger' + (menu === 'account' ? ' is-open' : '')} aria-label={ui("アカウントメニュー", "Account menu")} aria-expanded={menu === 'account'} aria-controls="menu-account" onClick={() => toggleMenu('account')}>
    <strong>{session.user.display_name || session.user.account_name}</strong><ChevronDown size={15} />
  </button></>;

  if (inRoom && joinCandidate?.id === activeId && joinCandidate &&
      (joinCandidate.access_mode === 'anonymous' || (joinCandidate.access_mode === 'registered' && joinCandidate.directory_listed))) {
    return <PublicChat key={joinCandidate.id} roomId={joinCandidate.id} onBack={openInbox} onLogin={openInbox}
      onAccountJoin={async () => { await request(`/rooms/${joinCandidate.id}/join`, {method:'POST'}); await loadRoom(joinCandidate.id); }}/>;
  }
  let content: ReactNode;
  if (tab === 'agents') content = <AgentSettings key={selectedAgent ?? 'list'} agents={agents} connections={connections} accountName={session.user.account_name} selectedAgent={selectedAgent} onSelect={openAgent} onDeleted={id => { setAgents(items => items.filter(a => a.id !== id)); openAgent(null); run(Promise.all([loadAgents(), loadRooms(), loadImages()])); }} onReload={() => run(loadAgents())} onAdd={addAgent} />;
  else if (tab === 'notifications') content = <Notifications items={notifications} onOpen={openNotice} />;
  else if (tab === 'account') content = <AccountSettings onAgents={() => openAgent(null)} onProfileSaved={patch => setSession(previous => previous?.authenticated ? { ...previous, user: { ...previous.user, ...patch } } : previous)} user={session.user} operator={session.operator} section={accountSection} onSelect={openAccountSection} />;
  else if (inviteCode) content = <InviteView code={inviteCode} onAccept={(id) => { run(loadRooms()); openRoom(id); }} onCancel={openInbox} />;
  else if (currentDetail) content = <Chat onRepliesRead={refreshNotices} refreshHistory={() => run(loadRoom(currentDetail.room.id))} key={currentDetail.room.id} focus={focus} onFocus={setFocus} user={session.user} detail={currentDetail} items={timeline.items} hasOlder={timeline.has_more} loadingOlder={loadingOlder} onOlder={() => void loadOlder()} onSend={send} onReact={react} onAgentChanged={(id, name) => agentRenamed(currentDetail.room.id, id, name)} onEdit={(message, body) => void modify(message, body)} onDelete={(message) => void modify(message)} onReport={(message) => void report(message)} onBlock={(message) => void block(message)} />;
  else if (joinCandidate && activeId === joinCandidate.id) content = <div className="welcome-panel"><RoomFaces room={joinCandidate} /><h1>{joinCandidate.name}</h1><p>{joinCandidate.host_account} · {accessLabel(joinCandidate.access_mode)}</p><button className="primary-button" onClick={() => void joinPublicRoom(joinCandidate.id)}>{ui("ルームに参加", "Join room")}</button></div>;
  else if (activeId) content = <div className="welcome-panel" role="status"><p>{error ? ui("会話を開けませんでした。", "Could not open the chat.") : ui("会話を読み込み中…", "Loading chat…")}</p></div>;
  else content = <><RoomListRefresh reload={() => loadRooms().catch(cause => setError(cause instanceof Error ? cause.message : ui("ルームを取得できませんでした。","Could not load rooms.")))}/>
    <RoomInbox rooms={rooms} loaded={roomsLoaded} onOpen={openRoom} onCreate={createRoom} /></>;

  return <ImageContext.Provider value={{ images, refresh: loadImages }}><div className={'app-shell with-primary-nav' + (atInbox ? ' room-list-page' : '') + (inRoom ? ' reading-room' : '')}>
    <PrimaryNavigation current={tab === 'rooms' ? 'rooms' : undefined} onNavigate={navigatePage}/>
    <header className={tab === 'account' ? 'app-bar settings-bar' : 'app-bar'} ref={toolbarRef}><div className="app-bar-inner">
      {!atInbox && <button type="button" className="toolbar-button back-to-rooms" aria-label={tab === 'account' && history.state?.fromAppPage ? ui("戻る", "Back") : (tab === 'account' && accountSection) || (tab === 'agents' && history.state?.fromSettings) ? ui("設定に戻る", "Back to settings") : tab === 'agents' && history.state?.fromAgentList ? ui("エージェント一覧に戻る", "Back to agents") : ui("ルームに戻る", "Back to rooms")} onClick={tab === 'account' && accountSection ? closeAccountSection : tab === 'agents' && (history.state?.fromSettings || history.state?.fromAgentList) ? () => history.back() : openInbox}><ChevronLeft size={24} /></button>}
      {inRoom ? <button type="button" className="room-switch" aria-label={ui("メンバー", "Members")} disabled={!currentDetail} aria-haspopup="dialog" onClick={() => { setMenu(null); setMembersOpen('メンバー'); }}>
        {currentRoom && <RoomFaces room={currentRoom} />}
        <span className="room-switch-copy"><strong>{currentRoom?.name || joinCandidate?.name || ui("ルーム", "Rooms")}</strong>
          {currentDetail && <small>{ui("メンバー", "Members")} {currentDetail.members.length}</small>}</span>
      </button> : tab === 'account' ? <h1 className="account-bar-title">{accountSection ? accountTitles[accountSection] : ui('設定', 'Settings')}</h1> : accountButton}
      <div className="toolbar-actions">
        {inRoom && publicAccess && currentDetail?.room.access_mode === 'anonymous' && currentDetail.room.id === introRoomId && <IntroAgentInvite/>}
        {inRoom ? <button type="button" className="toolbar-button" aria-label={ui("トーク設定", "Chat settings")} title={ui("トーク設定", "Chat settings")} aria-haspopup="dialog" disabled={!currentDetail} onClick={() => { setMenu(null); setMembersOpen('トーク設定'); }}><Settings2 size={23} /></button>
          : atInbox && <button type="button" className="toolbar-button" aria-label={ui("ルームを作成", "Create room")} title={ui("ルームを作成", "Create room")} onClick={createRoom}><SquarePen size={23} /></button>}
      </div>
      {menu === 'agents' && <section className={'popover' + (inRoom ? ' popover-right' : '')} id="menu-agents" aria-label={ui("エージェント一覧", "Agent list")}>
        <div className="popover-heading"><h2>{ui("エージェント", "Agents")}</h2><button className="icon-button" aria-label={ui("エージェントを追加", "Add agent")} onClick={addAgent}><Plus size={20} /></button></div>
        <div className="popover-list">{agents.length ? <ScrollItems items={agents}>{agent => <button className="menu-agent" key={agent.id} onClick={() => openAgent(agent.id)}><Avatar name={agent.name} agent subjectId={agent.id} /><span><strong>{agent.name}</strong><small>{agent.platform} · @{agent.handle}</small></span><ChevronRight size={16} /></button>}</ScrollItems> : <p className="popover-empty">{ui("エージェントはまだ登録されていません", "No agents yet")}</p>}</div>
      </section>}
      {menu === 'account' && !inRoom && <section className="popover popover-account" id="menu-account" aria-label={ui("アカウントメニュー", "Account menu")}>
          <div className="popover-account-head"><Avatar name={session.user.display_name || session.user.account_name} subjectId={session.user.id} /><strong>{session.user.display_name || session.user.account_name}</strong></div>
          <button className="menu-action" aria-controls="menu-agents" onClick={() => setMenu('agents')}><ContactRound size={18} />{ui("エージェント", "Agents")}</button>
          <button className="menu-action" onClick={() => { setMenu(null); navigatePage('/notifications'); }}><Bell size={18}/>{ui("通知", "Notifications")}{unreadNotices && <span className="inline-dot" role="img" aria-label={ui("未読", "Unread")}/>}</button>
          <button className="menu-action" onClick={() => selectTab('account')}><Settings2 size={18} />{ui("設定", "Settings")}</button>
          <button className="menu-action" onClick={() => { setMenu(null); setConfirmLogout(true); }}><LogOut size={18} />{ui("ログアウト", "Sign out")}</button>
      </section>}
    </div></header>
    <main className="main-panel">{error && <div className="global-error" role="alert"><span>{error}</span><button aria-label={ui("閉じる", "Close")} onClick={() => setError('')}><X size={16} /></button></div>}{content}</main>
    <MessageToast key={session.user.id} onIncoming={m => {
      run(currentDetail?.room.id === m.room_id ? loadRoom(m.room_id) : loadRooms());
      refreshNotices();
    }} onOpen={m => void openMessage(m.room_id, m.id, m.seq)} />
    {confirmLogout && <LogoutDialog onClose={() => setConfirmLogout(false)} onConfirm={logout}/>}
    {addingAgent && <AgentForm onClose={() => setAddingAgent(false)} onCreate={(id) => { setAddingAgent(false); run(loadAgents()); openAgent(id); }} />}
    {newRoom && <NewRoom privateBeta={session.privateBeta} onClose={() => setNewRoom(false)} onCreate={(id) => { setNewRoom(false); run(loadRooms()); openRoom(id); }} />}
    {membersOpen && currentDetail && <RoomMembers title={membersOpen === 'トーク設定' ? ui('トーク設定', 'Chat settings') : ui('メンバー', 'Members')} detail={currentDetail} onSettingsSaved={patch => applyRoomSettings(currentDetail.room.id, patch)} agents={agents} user={session.user} privateBeta={session.privateBeta} onClose={() => setMembersOpen(null)} onChanged={() => loadRoom(currentDetail.room.id)} onDeleted={() => { setMembersOpen(null); openInbox(); }} />}
  </div></ImageContext.Provider>;
}
