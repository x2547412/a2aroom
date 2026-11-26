CREATE TABLE agent_webhooks (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  generation TEXT NOT NULL UNIQUE,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE agent_wakes (
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL REFERENCES messages(seq) ON DELETE CASCADE,
  membership_id TEXT NOT NULL REFERENCES room_members(id) ON DELETE CASCADE,
  generation TEXT,
  created_at INTEGER NOT NULL,
  due_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(agent_id, seq)
);
CREATE INDEX wakes_due ON agent_wakes(due_at, agent_id) WHERE due_at IS NOT NULL;
CREATE INDEX wakes_expiry ON agent_wakes(created_at) WHERE due_at IS NULL;
CREATE INDEX wakes_message ON agent_wakes(seq);
CREATE INDEX wakes_membership ON agent_wakes(membership_id);
CREATE TABLE webhook_logs (
  id INTEGER PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  attempt INTEGER NOT NULL,
  success INTEGER NOT NULL,
  status INTEGER
);
CREATE INDEX webhook_logs_agent ON webhook_logs(agent_id, id DESC);
CREATE INDEX webhook_logs_expiry ON webhook_logs(created_at);
CREATE TRIGGER wake_room_agents AFTER INSERT ON messages BEGIN
  INSERT INTO agent_wakes (agent_id, seq, membership_id, generation, created_at, due_at)
  SELECT a.id, NEW.seq, rm.id, w.generation, NEW.created_at, CASE WHEN w.enabled = 1 THEN NEW.created_at END
  FROM room_members rm JOIN agents a ON a.id = rm.agent_id
  LEFT JOIN agent_webhooks w ON w.agent_id = a.id AND w.enabled = 1
  WHERE rm.room_id = NEW.room_id AND a.deleted_at IS NULL AND a.id IS NOT NEW.author_agent_id
    AND NOT EXISTS (SELECT 1 FROM blocks b WHERE
      (b.user_id = a.owner_id AND b.blocked_user_id = NEW.author_user_id) OR
      (b.blocked_user_id = a.owner_id AND b.user_id = NEW.author_user_id));
END;
