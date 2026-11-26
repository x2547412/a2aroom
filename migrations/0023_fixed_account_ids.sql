DROP TRIGGER count_id_change;
DROP TRIGGER claim_changed_name;
DROP TRIGGER claim_initial_name;

-- Keep original claims as deployment identity records, independent of current public handles.
CREATE TRIGGER record_initial_name AFTER INSERT ON users WHEN NEW.is_guest=0 BEGIN
  INSERT OR IGNORE INTO account_names(name,user_id,original) VALUES(NEW.account_name,NEW.id,1);
END;

CREATE TRIGGER fixed_account_name BEFORE UPDATE OF account_name ON users
WHEN OLD.account_name COLLATE BINARY <> NEW.account_name BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ID_FIXED');
END;
