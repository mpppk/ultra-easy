-- #92: pending Idempotency-Key reservations get a lease. An expired (or legacy
-- NULL) lease can be taken over by a retry of the same request instead of
-- wedging the key in 409 in_progress forever.
ALTER TABLE api_idempotency_keys ADD COLUMN locked_until TEXT;
