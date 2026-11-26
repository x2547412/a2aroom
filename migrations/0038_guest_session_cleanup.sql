CREATE INDEX guest_sessions_user_expiry_idx ON guest_sessions(user_id,expires_at);
