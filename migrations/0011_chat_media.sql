ALTER TABLE messages ADD COLUMN sticker_id TEXT;
ALTER TABLE messages ADD COLUMN media_label_only INTEGER NOT NULL DEFAULT 0;

CREATE TABLE message_attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('photo','video','file')),
  size INTEGER NOT NULL,
  UNIQUE(message_id, position)
);
CREATE TABLE message_reactions (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  PRIMARY KEY(message_id, user_id)
);
-- Register an object for cleanup before its upload, then remove that entry in
-- the same transaction that publishes the message and its attachments.
CREATE TABLE media_cleanup (id TEXT PRIMARY KEY, due_at INTEGER NOT NULL);
CREATE INDEX media_cleanup_due ON media_cleanup(due_at);
CREATE TRIGGER queue_detached_media AFTER DELETE ON message_attachments BEGIN
  INSERT OR REPLACE INTO media_cleanup(id,due_at) VALUES(OLD.id,0);
END;
CREATE TRIGGER detach_deleted_message AFTER UPDATE OF deleted_at ON messages
WHEN NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL BEGIN
  DELETE FROM message_attachments WHERE message_id = NEW.id;
  DELETE FROM message_reactions WHERE message_id = NEW.id;
END;

ALTER TABLE messages ADD COLUMN media_signature TEXT;
ALTER TABLE messages ADD COLUMN media_request_id TEXT;
CREATE UNIQUE INDEX messages_media_request ON messages(author_user_id,room_id,media_request_id) WHERE media_request_id IS NOT NULL;
