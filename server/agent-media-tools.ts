import { Buffer } from 'node:buffer';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { maxFileBytes, maxFiles, stickers } from '../shared/chat';
import { prepareMedia } from './chat-media';
import { enforceIpRate, sha256 } from './security';
import { postAgentMessage } from './store';
import { signalMessage } from './wakes';
import { HttpError, type AgentAuth, type Bindings } from './types';
import type { ToolRunner } from './agent-chat-tools';

const chunkSize=512*1024;
const maxChunks=Math.ceil(maxFileBytes/chunkSize)+maxFiles;
export const mcpBodyLimit=768*1024;

export function registerMediaTools(server:McpServer,env:Bindings,ctx:Pick<ExecutionContext,'waitUntil'>,request:Request,
  roomField:z.ZodString | z.ZodOptional<z.ZodString>,
  resolve:(room?:string)=>Promise<{auth:AgentAuth;room:string;guestHash?:string}>,run:ToolRunner) {
  const key = (agent:string,room:string,token:string)=>sha256('mcp-chunk:'+agent+':'+room+':'+token);
  server.registerTool('upload_attachment_chunk',{description:'Stage up to 512 KiB of Base64 file bytes for one hour. Send the resulting chunk IDs in order to post_media_message.',
    inputSchema:{room_id:roomField,data:z.string().min(4).max(4*Math.ceil(chunkSize/3))}},({room_id,data})=>run(async()=>{
    const {auth,room}=await resolve(room_id);
    await enforceIpRate(env,request,'mcp-upload-chunk',180,3600_000);
    const bytes=Buffer.from(data,'base64');
    if (!bytes.length || bytes.length>chunkSize || bytes.toString('base64')!==data)
      throw new HttpError(400,'INVALID_CHUNK','Use standard padded Base64.');
    const token=crypto.randomUUID(), id=await key(auth.agent.id,room,token), expires=Date.now()+3600_000;
    await env.DB.prepare('INSERT INTO media_cleanup(id,due_at) VALUES(?,?)').bind(id,expires).run();
    await env.CHAT_MEDIA.put('chat/'+id,bytes,{customMetadata:{expires:String(expires)}});
    return {chunk_id:token,expires_at:expires};
  }));
  server.registerTool('post_media_message',{description:'Post attachments, a sticker, or both, with optional caption and reply. Up to four files and 25 MiB total. Reuse request_id on retry.',
    inputSchema:{room_id:roomField,request_id:z.string().uuid(),body:z.string().max(4000).default(''),reply_to:z.string().optional(),
      sticker:z.enum(stickers.map(s=>s.id)).optional(),files:z.array(z.object({name:z.string().min(1).max(180),mime:z.string().max(100).optional(),
        chunks:z.array(z.string().uuid()).min(1).max(maxChunks)})).max(maxFiles).default([])}},args=>run(async()=>{
    const {auth,room,guestHash}=await resolve(args.room_id);
    await enforceIpRate(env,request,'mcp-media-post',60,3600_000);
    if (args.files.reduce((n,f)=>n+f.chunks.length,0)>maxChunks) throw new HttpError(400,'TOO_MANY_CHUNKS','Use 512 KiB chunks except the final chunk per file.');
    const requestId=await sha256('mcp-media:'+auth.agent.id+':'+args.request_id);
    const existing=await env.DB.prepare('SELECT id FROM messages WHERE room_id=? AND author_agent_id=? AND media_request_id=? AND deleted_at IS NULL')
      .bind(room,auth.agent.id,requestId).first<string>('id');
    if (existing) return {id:existing,warnings:[]};
    let total=0;
    const files:File[]=[];
    for (const input of args.files) {
      const parts:ArrayBuffer[]=[];
      for (const token of input.chunks) {
        const obj=await env.CHAT_MEDIA.get('chat/'+await key(auth.agent.id,room,token));
        if (!obj || Number(obj.customMetadata?.expires||0)<=Date.now()) throw new HttpError(404,'CHUNK_UNAVAILABLE','Upload a fresh chunk for this agent and room.');
        total+=obj.size;
        if (total>maxFileBytes) throw new HttpError(400,'INVALID_FILES','Maximum total is 25 MiB.');
        parts.push(await obj.arrayBuffer());
      }
      files.push(new File(parts,input.name,{type:input.mime}));
    }
    const {body,reply,media}=await prepareMedia(args.body,args.reply_to??null,args.request_id,files,args.sticker??null);
    media.requestId=requestId;
    const posted=await postAgentMessage(env,auth,room,body,reply,guestHash,media);
    ctx.waitUntil(signalMessage(env,posted.id));
    return posted;
  }));
}
