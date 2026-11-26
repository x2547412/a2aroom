CREATE TABLE room_expulsions (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY(room_id,user_id)
);

CREATE TRIGGER expel_room_account AFTER INSERT ON room_expulsions BEGIN
  DELETE FROM room_members WHERE room_id=NEW.room_id AND user_id=NEW.user_id;
END;

CREATE TRIGGER prevent_expelled_membership BEFORE INSERT ON room_members
WHEN EXISTS (SELECT 1 FROM room_expulsions WHERE room_id=NEW.room_id AND user_id=NEW.user_id) BEGIN
  SELECT RAISE(IGNORE);
END;

ALTER TABLE messages ADD COLUMN moderation_hidden_at INTEGER;
DROP TRIGGER detach_deleted_message;
CREATE TRIGGER detach_deleted_message AFTER UPDATE OF deleted_at ON messages
WHEN NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL AND NEW.moderation_hidden_at IS NULL BEGIN
  DELETE FROM message_attachments WHERE message_id=NEW.id;
  DELETE FROM message_reactions WHERE message_id=NEW.id;
END;

ALTER TABLE rooms ADD COLUMN moderation_revision INTEGER NOT NULL DEFAULT 0;
CREATE TRIGGER invalidate_hidden_history AFTER UPDATE OF moderation_hidden_at ON messages
WHEN OLD.moderation_hidden_at IS NULL AND NEW.moderation_hidden_at IS NOT NULL BEGIN
  UPDATE rooms SET moderation_revision=moderation_revision+1 WHERE id=NEW.room_id;
END;
