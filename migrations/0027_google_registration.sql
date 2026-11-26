DELETE FROM google_login_confirmations;
ALTER TABLE google_login_confirmations ADD COLUMN email TEXT;
ALTER TABLE users DROP COLUMN password_hash;
ALTER TABLE users DROP COLUMN password_salt;
