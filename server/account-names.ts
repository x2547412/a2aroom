// The deployment owner is identified by the immutable claim made at setup.
export const configuredOwnerId = '(SELECT user_id FROM account_names WHERE name=? AND original=1)';
