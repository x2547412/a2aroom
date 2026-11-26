CREATE TABLE workspace_sessions (
  token_hash TEXT PRIMARY KEY,
  session_hash TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
  account_name TEXT NOT NULL,
  next_path TEXT,
  expires_at INTEGER NOT NULL
);
CREATE INDEX workspace_sessions_expiry ON workspace_sessions(expires_at);
CREATE INDEX workspace_sessions_parent ON workspace_sessions(session_hash);
