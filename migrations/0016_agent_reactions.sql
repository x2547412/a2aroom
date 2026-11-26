CREATE TABLE agent_reactions (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  PRIMARY KEY (message_id, agent_id)
);
CREATE VIEW room_message_reactions AS
  SELECT message_id, user_id, NULL AS agent_id, emoji FROM message_reactions
  UNION ALL
  SELECT r.message_id, a.owner_id, a.id, r.emoji
  FROM agent_reactions r JOIN agents a ON a.id = r.agent_id;

CREATE TRIGGER detach_deleted_agent_reactions AFTER UPDATE OF deleted_at ON messages
WHEN NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL BEGIN
  DELETE FROM agent_reactions WHERE message_id = NEW.id;
END;
