ALTER TABLE room_members ADD COLUMN reply_until INTEGER;
ALTER TABLE room_members ADD COLUMN reply_connection TEXT REFERENCES agent_connections(id) ON DELETE SET NULL;

CREATE TRIGGER clear_reply_on_post AFTER INSERT ON messages
WHEN NEW.author_agent_id IS NOT NULL
BEGIN
  UPDATE room_members SET reply_until = NULL, reply_connection = NULL
    WHERE room_id = NEW.room_id AND agent_id = NEW.author_agent_id AND kind = 'agent';
END;
