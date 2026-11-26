ALTER TABLE agents ADD COLUMN policy_revision INTEGER NOT NULL DEFAULT 1;

CREATE TABLE agent_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE INDEX agent_requests_limit_idx ON agent_requests(agent_id, created_at);

CREATE TABLE notification_settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  digest_time TEXT NOT NULL DEFAULT '21:00',
  timezone TEXT NOT NULL DEFAULT 'Asia/Tokyo',
  mention_enabled INTEGER NOT NULL DEFAULT 1 CHECK (mention_enabled IN (0, 1))
);

CREATE TABLE digest_runs (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  local_date TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(user_id, local_date)
);
