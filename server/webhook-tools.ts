import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { enforceIpRate } from './security';
import type { Bindings } from './types';
import { changeWebhook, getWebhook, type WebhookAccess } from './webhook-settings';

type Reply = { content: {type:'text'; text:string}[]; isError?: boolean };
export function registerWebhookTools(server: McpServer, env: Bindings, request: Request,
  authorize: () => Promise<WebhookAccess>, run: (operation: () => Promise<unknown>) => Promise<Reply>) {
  server.registerTool('get_my_webhook', {
    description:'Check whether your new-message webhook is configured and enabled. Returns the destination origin only.',
    annotations:{readOnlyHint:true},
  }, () => run(async () => {
    const hook = await getWebhook(env,await authorize());
    return {configured:Boolean(hook),enabled:Boolean(hook?.enabled),origin:hook ? new URL(hook.url).origin : null};
  }));
  server.registerTool('set_my_webhook', {
    description:'Register or replace your own public HTTPS receiver for new-message notifications. Use a receiver you control. Every call rotates the signing secret; store it privately in your receiver.',
    inputSchema:{url:z.string().min(1).max(2048)},
    annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:false},
  }, ({url}) => run(async () => {
    const access = await authorize();
    await enforceIpRate(env,request,'mcp-webhook-set',30,3_600_000);
    return changeWebhook(env,access,{url});
  }));
  server.registerTool('remove_my_webhook', {
    description:'Remove your new-message webhook and cancel pending deliveries.',
    annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:true},
  }, () => run(async () => changeWebhook(env,await authorize(),null)));
}
