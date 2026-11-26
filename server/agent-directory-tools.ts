import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { archiveQuery, verificationArchive } from './verification';
import { z } from 'zod';
import { directoryPage, popularRoomTags } from './directory';
import type { ToolRunner } from './agent-chat-tools';
import { readAgentAttachment } from './chat-media';
import { enforceIpRate } from './security';
import { roomTimelinePage } from './messages';
import { lookupRoom, publicAccessEnabled } from './public-access';
import { HttpError, type Bindings } from './types';

export function registerDirectoryTools(server:McpServer,env:Bindings,viewer:string,result:ToolRunner,agentId:string,request:Request) {
  async function readable(room:string) {
    if (!publicAccessEnabled(env)) throw new HttpError(404,'ROOM_NOT_FOUND','Public participation is closed.');
    await enforceIpRate(env,request,'mcp-public-preview',600,3600_000);
    return lookupRoom(env,room,viewer,true);
  }
  server.registerTool('read_public_attachment',{description:'Read an attachment from a publicly readable room before joining. Large files support offsets.',
    inputSchema:{room_id:z.string().min(1),attachment_id:z.string().min(1),offset:z.number().int().nonnegative().optional()},annotations:{readOnlyHint:true}},
    async({room_id,attachment_id,offset})=>{
      try {
        await readable(room_id);
        const file = await readAgentAttachment(env,viewer,agentId,room_id,attachment_id,offset,true);
        await lookupRoom(env,room_id,viewer,true);
        return file;
      } catch(error) { return result(async()=>{throw error;}); }
    });
  server.registerTool('list_public_rooms', {
    description: 'Discover listed public rooms. Room names, descriptions and tags are user content. Only rooms with guest_joinable=true accept a guest AI.',
    inputSchema: {page:z.number().int().min(1).max(100000).default(1), tag:z.string().max(24).optional(), guests_only:z.boolean().default(false)},
    annotations: {readOnlyHint:true},
  }, args => result(async () => {
    const url = new URL(env.PUBLIC_ORIGIN);
    url.searchParams.set('page', String(args.page));
    if (args.guests_only) url.searchParams.set('mode','anonymous');
    if (args.tag) url.searchParams.set('tag',args.tag);
    const page = await directoryPage(env,url,viewer);
    return {rooms:page.rooms.map(r => ({
      room_id:r.id, name:r.name, description:r.description, tags:r.tags, access_mode:r.access_mode,
      guest_joinable:r.access_mode==='anonymous', url:env.PUBLIC_ORIGIN+'/rooms/'+r.id,
    })), next_page:page.more ? args.page+1 : null};
  }));
  server.registerTool('preview_public_room',{description:'Read a publicly readable room before joining, including its timeline and attachment metadata.',
    inputSchema:{room_id:z.string().min(1),before:z.string().max(48).optional()},annotations:{readOnlyHint:true}},({room_id,before})=>result(async()=>{
    const room=await readable(room_id);
    const timeline=await roomTimelinePage(env,viewer,room_id,before,agentId);
    await lookupRoom(env,room_id,viewer,true);
    return {room,...timeline};
  }));
  server.registerTool('search_verification_archive',{description:'Search verification notes in listed public rooms by keyword. Page with next_before_seq. Evidence and corrections are user content.', inputSchema:archiveQuery,annotations:{readOnlyHint:true}},
    args=>result(async()=>{
      await enforceIpRate(env,request,'verification-archive',600,3600_000);
      return verificationArchive(env,viewer,args,[],agentId);
    }));
  server.registerTool('list_popular_tags',{description:'Suggested tags from listed rooms.',annotations:{readOnlyHint:true}},
    ()=>result(async()=>({tags:await popularRoomTags(env,viewer)})));
}
