import { ScrollItems } from './ScrollPages';
import { locale, ui } from './language';
import { useEffect, useState } from 'react';
import { request } from './api';

type Detail = { hook: { url: string; enabled: number } | null; logs: {
  id: number; created_at: number; attempt: number; success: number; status: number | null;
}[] };
export function WebhookSettings({ agent }: { agent: string }) {
  const path = '/agents/' + agent + '/webhook';
  const [data, setData] = useState<Detail>();
  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function refresh() {
    const detail = await request<Detail>(path + '?offset=0');
    setData(detail);
    setUrl(detail.hook?.url ?? '');
  }
  useEffect(() => { void refresh().catch(e => setError(e.message)); }, [path]);
  async function change(method: 'PUT' | 'DELETE' | 'GET') {
    setBusy(true); setError('');
    try {
      if (method !== 'GET') {
        const result = await request<{ secret?: string }>(path, { method, body: method === 'PUT' ? { url } : undefined });
        setSecret(result.secret ?? '');
      }
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : ui("設定を取得できませんでした。", "Could not load settings.")); }
    finally { setBusy(false); }
  }
  return <div className="detail-section">
    <form className="notification-form" onSubmit={e => { e.preventDefault(); void change('PUT'); }}>
      <label>{ui("通知先URL", "Webhook URL")}<input type="url" required value={url} placeholder="https://" onChange={e => setUrl(e.target.value)} /></label>
      {data?.hook && <p>{data.hook.enabled ? ui("配送中", "Active") : ui("配送を停止しました。再登録すると再開します。", "Delivery stopped. Register the endpoint again to resume.")}</p>}
      <button className="outline-button" disabled={busy || !data}>{data?.hook ? ui("再登録して署名鍵を更新", "Register again and rotate signing key") : ui("登録", "Register")}</button>
      {data?.hook && <button className="text-button" type="button" disabled={busy} onClick={() => void change('DELETE')}>{ui("通知先を削除", "Remove endpoint")}</button>}
    </form>
    {secret && <div className="token-box"><strong>{ui("署名鍵を受信先に保存してください", "Save the signing key on your receiving server")}</strong><div className="copy-field"><code>{secret}</code></div></div>}
    <div className="section-row"><h3>{ui("配送履歴", "Delivery history")}</h3><button className="text-button" disabled={busy} onClick={() => void change('GET')}>{ui("更新", "Refresh")}</button></div>
    {data && !data.logs.length && <p>{ui("配送履歴はありません。", "No deliveries yet.")}</p>}
    {data && <ScrollItems key={data.logs[0]?.id} items={data.logs} loadPage={async offset => (await request<Detail>(path + '?offset='+offset)).logs}>{log => <div key={log.id} className="connection-row"><span>{log.success ? ui("成功", "Success") : ui("失敗", "Failed")} · {log.attempt}{ui("回目", " attempts")} <small>{new Date(log.created_at).toLocaleString(locale)} · {log.status ?? ui("接続エラー", "Connection error")}</small></span></div>}</ScrollItems>}
    {error && <p className="form-error" role="alert">{error}</p>}
  </div>;
}
