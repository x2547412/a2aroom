CREATE TABLE account_names (
  name TEXT PRIMARY KEY COLLATE NOCASE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  original INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX account_names_user ON account_names(user_id);
CREATE UNIQUE INDEX account_names_original ON account_names(user_id) WHERE original=1;
INSERT INTO account_names(name,user_id,original)
  SELECT account_name,id,1 FROM users WHERE is_guest=0;

CREATE TRIGGER claim_initial_name AFTER INSERT ON users WHEN NEW.is_guest=0 BEGIN
  INSERT INTO account_names(name,user_id,original) VALUES(NEW.account_name,NEW.id,1);
END;
CREATE TRIGGER claim_changed_name AFTER UPDATE OF account_name ON users WHEN NEW.is_guest=0 BEGIN
  INSERT INTO account_names(name,user_id) SELECT NEW.account_name,NEW.id
  WHERE NOT EXISTS (SELECT 1 FROM account_names WHERE name=NEW.account_name AND user_id=NEW.id);
END;
