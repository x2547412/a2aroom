PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  account_name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX sessions_expiry_idx ON sessions(expires_at);

CREATE TABLE login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX login_attempts_lookup_idx ON login_attempts(subject_hash, created_at);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'selective' CHECK (mode IN ('selective', 'mention_only', 'digest')),
  daily_limit INTEGER NOT NULL DEFAULT 20 CHECK (daily_limit BETWEEN 0 AND 200),
  quiet_start TEXT,
  quiet_end TEXT,
  timezone TEXT NOT NULL DEFAULT 'Asia/Tokyo',
  profile_text TEXT NOT NULL DEFAULT '',
  private_categories TEXT NOT NULL DEFAULT '["address","workplace","finance","health","family"]',
  tone_note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX agents_owner_idx ON agents(owner_id, deleted_at);

CREATE TABLE agent_connections (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('token', 'oauth')),
  token_hash TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX agent_connections_agent_idx ON agent_connections(agent_id, revoked_at);

CREATE TABLE rooms (
  id TEXT PRIMARY KEY,
  host_user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL CHECK (visibility IN ('invite', 'public')),
  created_at INTEGER NOT NULL
);
CREATE INDEX rooms_host_idx ON rooms(host_user_id, created_at);

CREATE TABLE room_members (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('human', 'agent')),
  joined_at INTEGER NOT NULL,
  CHECK ((kind = 'human' AND agent_id IS NULL) OR (kind = 'agent' AND agent_id IS NOT NULL))
);
CREATE UNIQUE INDEX room_human_unique ON room_members(room_id, user_id) WHERE kind = 'human';
CREATE UNIQUE INDEX room_agent_unique ON room_members(room_id, agent_id) WHERE kind = 'agent';
CREATE INDEX room_members_user_idx ON room_members(user_id, room_id);

CREATE TABLE messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  author_user_id TEXT NOT NULL REFERENCES users(id),
  author_agent_id TEXT REFERENCES agents(id),
  body TEXT NOT NULL,
  reply_to TEXT REFERENCES messages(id),
  created_at INTEGER NOT NULL,
  edited_at INTEGER,
  deleted_at INTEGER
);
CREATE INDEX messages_room_seq_idx ON messages(room_id, seq);
CREATE INDEX messages_agent_time_idx ON messages(author_agent_id, created_at);
CREATE INDEX messages_agent_room_time_idx ON messages(author_agent_id, room_id, created_at);

CREATE TABLE read_cursors (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('human', 'agent')),
  subject_id TEXT NOT NULL,
  last_seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (room_id, kind, subject_id)
);

CREATE TABLE room_invites (
  code_hash TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  revoked_at INTEGER
);

CREATE TABLE blocks (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(user_id, blocked_user_id),
  CHECK (user_id <> blocked_user_id)
);

CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  reporter_user_id TEXT NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  handled_at INTEGER
);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  room_id TEXT REFERENCES rooms(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  read_at INTEGER
);
CREATE INDEX notifications_user_idx ON notifications(user_id, created_at DESC);
