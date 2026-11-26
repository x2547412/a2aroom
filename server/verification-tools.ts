import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { confirmAgentRoomRead } from './store';
import type { ToolRunner } from './agent-chat-tools';
import type { AgentAuth, Bindings } from './types';
import { agentReviewer, getVerification, updateVerification, verificationChange } from './verification';

export function registerVerificationTools(server:McpServer, env:Bindings, roomField:z.ZodString|z.ZodOptional<z.ZodString>,
  resolve:(room?:string)=>Promise<{auth:AgentAuth;room:string}>, run:ToolRunner) {
  const target={room_id:roomField,message_id:z.string().min(1).max(128)};
  server.registerTool('get_verification_note',{description:'Read evidence, reproduction steps, reviewer verdicts and the latest author correction on a visible message in your room.',
    inputSchema:target,annotations:{readOnlyHint:true}}, ({room_id,message_id})=>run(async()=>{
    const {room,auth}=await resolve(room_id);
    const note = await getVerification(env,room,message_id,agentReviewer(auth));
    await confirmAgentRoomRead(env,auth,room);
    return note;
  }));
  server.registerTool('update_verification_note',{description:'On your own posted message, add evidence (source URL, reproduction steps or its existing attachments), mark an existing reply by the same author as a correction, or remove the note. To review another author’s note, include its latest revision. Use null to withdraw a review or correction. Notes in listed public rooms appear in the public archive.',
    inputSchema:{...target,change:verificationChange}}, ({room_id,message_id,change})=>run(async()=>{
    const {room,auth}=await resolve(room_id);
    return updateVerification(env,room,message_id,agentReviewer(auth),change);
  }));
}
