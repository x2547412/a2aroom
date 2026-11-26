import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { broadcastDirectory, roomDirectoryChanged } from './directory-hub';
import { roomEditorPredicate } from './room-access';
import { randomToken, sha256 } from './security';
import { HttpError, type AgentAuth, type Bindings } from './types';
import type { ToolRunner } from './agent-chat-tools';

export function registerHostTools(server:McpServer,env:Bindings,ctx:Pick<ExecutionContext,'waitUntil'>,
  roomField:z.ZodString | z.ZodOptional<z.ZodString>,
  resolve:(room?:string)=>Promise<{auth:AgentAuth;room:string;guestHash?:string}>,run:ToolRunner) {
  async function target(requested?:string) {
    const {auth,room,guestHash} = await resolve(requested);
    const {allowed,bindings} = roomEditorPredicate({id:room,host_user_id:auth.agent.owner_id},{agent:auth,guestHash});
    return {room,auth,sql:'SELECT id FROM rooms WHERE '+allowed,bindings};
  }
  function requireChange(result:D1Result) {
    if (!result.meta.changes) throw new HttpError(403,'HOST_ACTION_UNAVAILABLE','Check room ownership, membership and the selected participant.');
  }
  server.registerTool('create_room_invite',{description:'Create a private invite link valid for seven days for a room you host.',
    inputSchema:{room_id:roomField}},({room_id})=>run(async()=>{
    const host=await target(room_id);
    const code=randomToken(), now=Date.now(), expires=now+7*86400_000;
    requireChange(await env.DB.prepare('INSERT INTO room_invites(code_hash,room_id,created_by,created_at,expires_at) SELECT ?,id,?,?,? FROM ('+host.sql+')')
      .bind(await sha256(code),host.auth.agent.owner_id,now,expires,...host.bindings).run());
    return {url:env.PUBLIC_ORIGIN+'/invite/'+code,expires_at:expires};
  }));
  server.registerTool('revoke_room_invites',{description:'Revoke every active invite link for a room you host.',inputSchema:{room_id:roomField},
    annotations:{destructiveHint:true}},({room_id})=>run(async()=>{
    const host=await target(room_id);
    const [allowed,update]=await env.DB.batch([env.DB.prepare(host.sql).bind(...host.bindings),
      env.DB.prepare('UPDATE room_invites SET revoked_at=? WHERE revoked_at IS NULL AND room_id IN ('+host.sql+')').bind(Date.now(),...host.bindings)]);
    if (!allowed.results.length) throw new HttpError(403,'HOST_REQUIRED','Room creator required.');
    return {revoked:update.meta.changes};
  }));
  server.registerTool('remove_room_member',{description:'Remove a participant from a room you host. Removing a human also expels their agents.',
    inputSchema:{room_id:roomField,member_id:z.string().min(1)},annotations:{destructiveHint:true}},({room_id,member_id})=>run(async()=>{
    const host=await target(room_id);
    const filter='id=? AND room_id IN ('+host.sql+')';
    const args=[member_id,...host.bindings];
    const [human,agent]=await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO room_expulsions(room_id,user_id) SELECT room_id,user_id FROM room_members WHERE kind='human' AND user_id<>? AND "+filter).bind(host.auth.agent.owner_id,...args),
      env.DB.prepare("DELETE FROM room_members WHERE kind='agent' AND agent_id<>? AND "+filter).bind(host.auth.agent.id,...args),
    ]);
    if (!human.meta.changes) requireChange(agent);
    ctx.waitUntil(roomDirectoryChanged(env,host.room));
    return {removed:true};
  }));
  server.registerTool('delete_room',{description:'Permanently delete the room you created, including its history. Supply its current name to confirm.',
    inputSchema:{room_id:roomField,confirm_name:z.string().min(1)},annotations:{destructiveHint:true}},({room_id,confirm_name})=>run(async()=>{
    const host=await target(room_id);
    requireChange(await env.DB.prepare('DELETE FROM rooms WHERE name=? AND id IN ('+host.sql+')').bind(confirm_name,...host.bindings).run());
    ctx.waitUntil(broadcastDirectory(env));
    return {deleted:true};
  }));
}
