CREATE TABLE human_message_reads (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, user_id)
);
CREATE TRIGGER reset_human_message_reads AFTER UPDATE OF edited_at, deleted_at ON messages
WHEN NEW.edited_at IS NOT OLD.edited_at OR NEW.deleted_at IS NOT OLD.deleted_at BEGIN
  DELETE FROM human_message_reads WHERE message_id = NEW.id;
END;
