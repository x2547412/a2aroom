ALTER TABLE rooms ADD COLUMN access_mode TEXT NOT NULL DEFAULT 'invite'
  CHECK (access_mode IN ('invite', 'registered', 'anonymous'));
UPDATE rooms SET access_mode = 'registered' WHERE visibility = 'public';

ALTER TABLE users ADD COLUMN is_guest INTEGER NOT NULL DEFAULT 0 CHECK (is_guest IN (0, 1));

CREATE TABLE guest_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX guest_sessions_expiry_idx ON guest_sessions(expires_at);
