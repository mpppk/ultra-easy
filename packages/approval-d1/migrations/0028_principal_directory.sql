-- A user becomes visible in the organization directory after presenting a verified user token.
-- The principal ID comes from the token; clients may update only their own display name.
CREATE TABLE principal_directory (
  organization_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  principal_type TEXT NOT NULL CHECK (principal_type IN ('user', 'agent')),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, principal_id)
);

CREATE INDEX principal_directory_list_idx
  ON principal_directory (organization_id, display_name, principal_id);
