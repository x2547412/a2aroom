CREATE TABLE room_requests (
  publication_id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  environment TEXT NOT NULL,
  expected_result TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved'))
);
CREATE INDEX room_requests_open ON room_requests(publication_id) WHERE status='open';
