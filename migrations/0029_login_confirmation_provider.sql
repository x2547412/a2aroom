ALTER TABLE google_login_confirmations ADD COLUMN provider TEXT NOT NULL DEFAULT 'google'
  CHECK(provider IN ('google','tiktok','chatgpt'));
