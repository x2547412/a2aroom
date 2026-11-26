ALTER TABLE rooms ADD COLUMN directory_listed INTEGER NOT NULL DEFAULT 0 CHECK (directory_listed IN (0,1));
CREATE INDEX rooms_directory_idx ON rooms(directory_listed, visibility, access_mode, created_at);
CREATE TABLE room_tags (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  tag_key TEXT NOT NULL,
  label TEXT NOT NULL,
  PRIMARY KEY (room_id, tag_key)
);
CREATE INDEX room_tags_key_idx ON room_tags(tag_key, room_id);
CREATE INDEX messages_directory_activity_idx ON messages(room_id, created_at, author_user_id, author_agent_id) WHERE deleted_at IS NULL;
CREATE INDEX guest_sessions_member_idx ON guest_sessions(room_id, user_id, expires_at);
CREATE TABLE site_inquiries (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL CHECK (category IN ('privacy','safety','other')),
  email TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  handled_at INTEGER
);
CREATE INDEX site_inquiries_inbox_idx ON site_inquiries(handled_at, created_at);
