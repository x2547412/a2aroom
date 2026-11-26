CREATE TABLE login_identities (
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY(provider, subject),
  UNIQUE(user_id, provider)
);
CREATE TABLE login_transactions (
  state_hash TEXT PRIMARY KEY,
  browser_hash TEXT NOT NULL,
  provider TEXT NOT NULL,
  verifier TEXT NOT NULL,
  nonce TEXT NOT NULL,
  link_user TEXT REFERENCES users(id) ON DELETE CASCADE,
  session_hash TEXT,
  next_path TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX login_transaction_expiry ON login_transactions(expires_at);
