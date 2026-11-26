CREATE TABLE device_login_requests (
  device_token_hash TEXT PRIMARY KEY,
  user_code_hash TEXT NOT NULL UNIQUE,
  approved_user_id TEXT REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);

CREATE INDEX device_login_requests_expiry ON device_login_requests(expires_at);
