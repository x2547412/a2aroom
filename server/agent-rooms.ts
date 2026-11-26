import { z } from 'zod';
import { parseTags } from './directory';
import { publicAccessEnabled, isDirectoryDeployment } from './public-access';
import { checkAgentConnection } from './store';
import { sha256 } from './security';
import { roomDirectoryChanged } from './directory-hub';
import { HttpError, type AgentAuth, type Bindings } from './types';

export const createRoomSchema = {
  request_id:z.string().uuid().describe('Generate one UUID per new room. Reuse it on retries.'),
  name:z.string().trim().min(1).max(80),description:z.string().trim().max(500).default(''),
  access_mode:z.enum(['invite','registered','anonymous']).default('invite'),
  tags:z.array(z.string()).max(5).default([]),directory_listed:z.boolean().default(false),
};
const shape=z.object(createRoomSchema);
const roomLimit = 10;
const roomWindowMs = 24 * 60 * 60 * 1000;

export class RoomCreationLimitError extends HttpError {
  constructor(readonly retryAt: string) {
    super(429, 'ROOM_CREATION_LIMIT', `This agent has created ${roomLimit} rooms in the past 24 hours. Retry at ${retryAt}. You can still join an existing room.`);
  }
}

const permission = `EXISTS (SELECT 1 FROM agents a JOIN agent_connections c ON c.agent_id=a.id
  WHERE a.id=? AND c.id=? AND a.autonomous_rooms=1 AND a.deleted_at IS NULL AND c.revoked_at IS NULL)`;
function checkPolicy(auth: AgentAuth) {
  if (!auth.agent.autonomous_rooms) throw new HttpError(403,'ROOM_AUTONOMY_DISABLED','Owner permission required.');
}

export async function createAgentRoom(env:Bindings,ctx:ExecutionContext,auth:AgentAuth,account:string,args:z.infer<typeof shape>) {
  checkPolicy(auth);
  const tags=parseTags(args.tags), agent=auth.agent;
  const id=await sha256('room:'+agent.id+':'+args.request_id);
  const origin=isDirectoryDeployment(env)?'https://'+account+'.a2aroom.com':env.PUBLIC_ORIGIN;
  const response={room_id:id,url:origin+'/rooms/'+id};
  const existing=()=>env.DB.prepare('SELECT 1 FROM rooms WHERE id=? AND creator_agent_id=?').bind(id,agent.id).first();
  if (await existing()) return response;
  const now=Date.now(), listed=args.access_mode!=='invite' && args.directory_listed && publicAccessEnabled(env);
  try {
    const [created]=await env.DB.batch([
      env.DB.prepare(`INSERT INTO rooms(id,host_user_id,creator_agent_id,name,description,visibility,access_mode,directory_listed,created_at)
        SELECT ?,?,?,?,?,?,?,?,? WHERE ${permission} AND
        (SELECT COUNT(*) FROM rooms WHERE creator_agent_id=? AND created_at>?)<?`)
        .bind(id,agent.owner_id,agent.id,args.name,args.description,args.access_mode==='invite'?'invite':'public',args.access_mode,Number(listed),now,
          agent.id,auth.connectionId,agent.id,now-roomWindowMs,roomLimit),
      env.DB.prepare("INSERT INTO room_members(id,room_id,user_id,agent_id,kind,joined_at) SELECT ?,id,?,?,'agent',? FROM rooms WHERE id=?")
        .bind(crypto.randomUUID(),agent.owner_id,agent.id,now,id),
      ...tags.map(label=>env.DB.prepare('INSERT INTO room_tags(room_id,tag_key,label) SELECT id,?,? FROM rooms WHERE id=?').bind(label.toLowerCase(),label,id)),
    ]);
    if (!created.meta.changes) {
      checkPolicy(await checkAgentConnection(env, agent.id, auth.connectionId, agent.owner_id));
      const threshold = await env.DB.prepare(`SELECT created_at FROM rooms WHERE creator_agent_id=? AND created_at>?
        ORDER BY created_at DESC LIMIT 1 OFFSET ?`).bind(agent.id, now - roomWindowMs, roomLimit - 1).first<number>('created_at');
      if (threshold !== null) throw new RoomCreationLimitError(new Date(threshold + roomWindowMs).toISOString());
      throw new HttpError(409, 'ROOM_CREATION_UNAVAILABLE', 'Retry with the same request ID.');
    }
  } catch (e) { if (!await existing()) throw e; }
  if (listed) ctx.waitUntil(roomDirectoryChanged(env,id));
  return response;
}

export async function joinAgentRoom(env:Bindings,ctx:ExecutionContext,auth:AgentAuth,room:string,invite?:string) {
  checkPolicy(auth);
  const user=auth.agent.owner_id;
  const allowed=`FROM rooms r WHERE r.id=? AND ${permission}
    AND (r.host_user_id=? OR (r.visibility='public' AND ?=1) OR EXISTS
      (SELECT 1 FROM room_invites i WHERE i.room_id=r.id AND i.code_hash=? AND i.revoked_at IS NULL AND (i.expires_at IS NULL OR i.expires_at>?)))
    AND NOT EXISTS (SELECT 1 FROM room_expulsions x WHERE x.room_id=r.id AND x.user_id=?)
    AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.user_id=? AND b.blocked_user_id=r.host_user_id) OR (b.blocked_user_id=? AND b.user_id=r.host_user_id))`;
  const now=Date.now();
  const [inserted,member]=await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO room_members(id,room_id,user_id,agent_id,kind,joined_at)
      SELECT ?,r.id,?,?,'agent',? ${allowed}`).bind(crypto.randomUUID(),user,auth.agent.id,now,room,auth.agent.id,auth.connectionId,user,
      Number(publicAccessEnabled(env)),invite?await sha256(invite):'',now,user,user,user),
    env.DB.prepare("SELECT id FROM room_members WHERE kind='agent' AND agent_id=? AND room_id=?").bind(auth.agent.id,room),
  ]);
  if (!member.results.length) throw new HttpError(403,'JOIN_FORBIDDEN','Room unavailable or a valid invite is required.');
  if (inserted.meta.changes) ctx.waitUntil(roomDirectoryChanged(env,room));
  return {room_id:room,joined:true};
}
