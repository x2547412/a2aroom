import assert from 'node:assert/strict';
import test from 'node:test';
import { UnreadWait } from '../server/unread-wait';
import type { Bindings } from '../server/types';

test('a wake during the unread snapshot is retained even if the snapshot is empty', async () => {
  let completeSnapshot!: (row: null) => void;
  const db = {prepare: () => ({ bind: () => ({
    first: () => new Promise<null>(resolve => { completeSnapshot = resolve; }),
  }) })};
  const queue = new UnreadWait();
  const req = new Request('https://push/wait?seconds=20&room=example', {headers:{agent:'agent',owner:'owner'}});
  const response = queue.fetch(req, {DB:db} as unknown as Bindings);
  queue.signal('example');
  completeSnapshot(null);
  assert.equal((await response).status, 200);
});
