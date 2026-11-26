import type { Bindings } from './types';

// Keep twice the longest rate window (24 hours) to tolerate delayed schedules.
const retentionMs = 48 * 60 * 60_000;
const batchSize = 10_000;

export async function cleanupRateLimits(env: Bindings, now: number) {
  const cutoff = now - retentionMs;
  await env.DB.batch(['login_attempts', 'agent_requests'].map(table =>
    env.DB.prepare(`DELETE FROM ${table} WHERE id IN
      (SELECT id FROM ${table} WHERE created_at < ? ORDER BY created_at LIMIT ?)`)
      .bind(cutoff, batchSize)));
}
