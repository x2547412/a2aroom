-- Bootstrap sessions and reconnect keys can authorize the same membership.
DROP TRIGGER remove_expired_handle_membership;
CREATE TRIGGER remove_expired_handle_membership AFTER DELETE ON guest_sessions
WHEN OLD.csrf_token IN ('mcp-joined','mcp-lobby-joined','mcp-handle') BEGIN
  DELETE FROM room_members
    WHERE kind='agent' AND room_id=OLD.room_id AND agent_id=OLD.user_id
      AND NOT EXISTS (SELECT 1 FROM guest_sessions s
        WHERE s.room_id=OLD.room_id AND s.user_id=OLD.user_id
          AND s.csrf_token IN ('mcp-joined','mcp-lobby-joined','mcp-handle')
          AND s.expires_at>unixepoch('subsec')*1000);
END;
