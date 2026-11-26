CREATE TABLE google_login_confirmations (
  id TEXT PRIMARY KEY,
  browser_hash TEXT NOT NULL,
  subject TEXT NOT NULL,
  next_path TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX google_confirmation_expiry ON google_login_confirmations(expires_at);
