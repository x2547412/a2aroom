import { directoryOrigin, directoryAppOrigin, isAccountOrigin } from '../shared/directory';
import { ui } from './language';
import { useEffect, useState } from 'react';
import { ApiError, request } from './api';

const labels = { google:'Google', tiktok:'TikTok', chatgpt:'ChatGPT' };
type Provider = keyof typeof labels;
type Method = { id: Provider; linked: boolean };

export function ExternalLogin({settings = false}: {settings?: boolean}) {
  const [methods,setMethods] = useState<Method[]>([]);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState(new URLSearchParams(location.search).get('external') === 'failed' ? ui("認証できませんでした。もう一度お試しください。", "Sign-in failed. Please try again.") : '');
  useEffect(() => {
    let active = true;
    request<{providers:Method[]}>('/external/providers').then(({providers}) => {
      if (active) setMethods(providers.filter(method => !settings || method.id !== 'google'));
    }).catch(() => { if (active) setError(ui("ログイン方法を取得できませんでした。", "Could not load sign-in options.")); });
    return () => { active = false; };
  },[settings]);
  async function start(p: Provider) {
    if (!settings && location.origin === directoryOrigin) {
      location.assign(directoryAppOrigin + '/?login=1&next=' + encodeURIComponent(location.pathname + location.search));
      return;
    }
    if (settings && (location.origin === directoryOrigin || isAccountOrigin(location.origin)) && location.origin !== directoryAppOrigin) {
      location.assign(directoryAppOrigin + '/account/profile?manage_login=1');
      return;
    }
    setBusy(true); setError('');
    try {
      const next = new URLSearchParams(location.search).get('next') ?? location.pathname + location.search;
      const {url} = await request<{url:string}>('/external/'+p+'/start',{method:'POST',body:{mode:settings?'link':'login',next}});
      location.assign(url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : ui("認証できませんでした。", "Sign-in failed."));
      setBusy(false);
    }
  }
  if (!methods.length && !error) return null;
  return <div className="external-login">
    {settings && <h3>{ui("ログイン方法", "Sign-in methods")}</h3>}
    {methods.map(({id,linked}) => settings && linked ? <p key={id}>{labels[id]}{ui("と連携済み", " linked")}</p> :
      <button key={id} type="button" className={id === 'google' ? 'google-login full' : 'outline-button full'} data-oai-siwc-button={id === 'chatgpt' ? '' : undefined}
        disabled={busy} onClick={() => void start(id)}>
        {id === 'google' && <img src="/icons/google-g.png" alt="" />}{settings ? ui(labels[id] + "と連携", "Link " + labels[id]) : ui(labels[id] + "で続ける", "Continue with " + labels[id])}
      </button>)}
    {error && <p role="alert" className="form-error">{error}</p>}
  </div>;
}

export function registrationFromSearch(search: string) {
  const params = new URLSearchParams(search);
  for (const provider of ['google','tiktok','chatgpt'] as const) {
    const id = params.get(provider+'_link');
    if (id) return {id,provider};
  }
}

export function RegistrationConfirmation({ id,provider }: { id:string; provider:Provider }) {
  const path = '/external/'+provider+'/confirmation/'+encodeURIComponent(id);
  const [account,setAccount] = useState<string | null | undefined>(undefined);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const [ended,setEnded] = useState(false);
  useEffect(() => {
    let active = true;
    request<{account:string|null}>(path).then(data => { if (active) setAccount(data.account); })
      .catch(cause => { if (active) { setEnded(true); setError(cause.message); } });
    return () => { active=false; };
  },[path]);
  async function cancel() {
    setBusy(true);
    try {
      if (!ended) await request(path+'/cancel',{method:'POST'});
      location.replace('/?login=1');
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 410) location.replace('/?login=1');
      else setError(cause instanceof Error ? cause.message : ui("取り消せませんでした。", "Could not cancel."));
    } finally { setBusy(false); }
  }
  return <main className="auth-screen"><div className="auth-form-wrap"><form className="auth-form" onSubmit={async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);setError('');
    try {
      const result = await request<{next:string}>(path,{method:'POST',body:{account:account ?? form.get('account')}});
      location.replace(result.next);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 410) setEnded(true);
      setError(cause instanceof Error ? cause.message : ui("本人確認に失敗しました。", "Could not verify your identity."));
    } finally { setBusy(false); }
  }}>
    <h1>{labels[provider]}{ui("で続ける", " sign-in")}</h1>
    {!ended && (account === undefined ? <p role="status">{ui("確認中…", "Checking…")}</p> : <>
      <label>{ui("アカウントID", "Account ID")}<input name="account" autoComplete="username" defaultValue={account ?? ''} readOnly={Boolean(account)} minLength={3} maxLength={32} required />
      <small>{ui("英数字とハイフンで設定します。登録後は変更できません。", "Use letters, numbers and hyphens. Your ID is permanent.")}</small></label>
      <small>{ui("登録すると", "By registering, you agree to the ")}<a href="/terms">{ui("利用規約", "Terms of Service")}</a>{ui("に同意したことになります。", ".")}<a href="/privacy">{ui("プライバシーポリシー", "Privacy Policy")}</a></small>
      <button className="primary-button full" disabled={busy}>{ui("登録して始める", "Create account")}</button>
    </>)}
    {error && <p role="alert" className="form-error">{error}</p>}
    <button className="outline-button full" disabled={busy} type="button" onClick={() => void cancel()}>{ended ? ui("ログインに戻る", "Back to sign in") : ui("キャンセル", "Cancel")}</button>
  </form></div></main>;
}
