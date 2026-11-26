import { guestAccess } from './public-access';
import { randomToken } from './security';
import { HttpError, type Bindings } from './types';
import { webhookTarget } from './webhook';

export type WebhookAccess = {
  agentId: string;
  ownerId: string;
  connectionId?: string;
  guest?: { room: string; hash: string };
};

function authorizedAgent(access: WebhookAccess) {
  let sql = 'SELECT a.id FROM agents a WHERE a.id=? AND a.owner_id=? AND a.deleted_at IS NULL';
  const args = [access.agentId, access.ownerId];
  if (access.connectionId) {
    sql += ' AND EXISTS (SELECT 1 FROM agent_connections c WHERE c.agent_id=a.id AND c.id=? AND c.revoked_at IS NULL)';
    args.push(access.connectionId);
  }
  if (access.guest) {
    sql += ' AND ' + guestAccess;
    args.push(access.guest.hash, access.guest.room, access.agentId);
  }
  return {sql, args};
}

export async function getWebhook(env: Bindings, access: WebhookAccess) {
  const {sql, args} = authorizedAgent(access);
  return env.DB.prepare(`SELECT url, enabled FROM agent_webhooks WHERE agent_id IN (${sql})`)
    .bind(...args).first<{url:string; enabled:number}>();
}

export async function changeWebhook(env: Bindings, access: WebhookAccess, setting: {url:unknown} | null) {
  const {sql, args} = authorizedAgent(access);
  const target = setting ? await webhookTarget(setting.url) : null;
  const secret = target ? randomToken() : null;
  // Check authority in the batch, after DNS resolution. Cancel deliveries for the previous generation.
  const [allowed] = await env.DB.batch([
    env.DB.prepare(sql).bind(...args),
    env.DB.prepare(`UPDATE agent_wakes SET due_at=NULL WHERE agent_id IN (${sql}) AND due_at IS NOT NULL`).bind(...args),
    target ? env.DB.prepare(`INSERT INTO agent_webhooks(agent_id,generation,url,secret)
      SELECT a.id,?,?,? FROM agents a WHERE a.id IN (${sql})
      ON CONFLICT(agent_id) DO UPDATE SET generation=excluded.generation,url=excluded.url,secret=excluded.secret,enabled=1`)
      .bind(crypto.randomUUID(),target.url.href,secret,...args)
      : env.DB.prepare(`DELETE FROM agent_webhooks WHERE agent_id IN (${sql})`).bind(...args),
  ]);
  if (!allowed.results.length) throw new HttpError(403,'WEBHOOK_FORBIDDEN','このエージェントの通知先は変更できません。');
  return target ? {secret} : {ok:true};
}
