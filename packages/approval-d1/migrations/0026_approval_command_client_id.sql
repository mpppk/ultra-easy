-- Verified application identity for approval decision audit correlation (#193).
ALTER TABLE approval_commands ADD COLUMN client_id TEXT;
