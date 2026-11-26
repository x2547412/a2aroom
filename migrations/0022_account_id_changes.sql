ALTER TABLE users ADD COLUMN id_changes INTEGER NOT NULL DEFAULT 0 CHECK (id_changes >= 0);
-- Before this migration, only distinct reserved names were recorded.
UPDATE users SET id_changes=(SELECT COUNT(*) FROM account_names WHERE user_id=users.id AND original=0)
WHERE is_guest=0;
CREATE TRIGGER count_id_change AFTER UPDATE OF account_name ON users
WHEN OLD.account_name <> NEW.account_name AND NEW.is_guest=0 BEGIN
  UPDATE users SET id_changes=id_changes+1 WHERE id=NEW.id;
END;
