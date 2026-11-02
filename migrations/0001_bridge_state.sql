-- Apply once to the existing D1 binding through the supported Sites migration workflow.
-- The request handler never creates tables or applies migrations.
-- A constant view provides the version marker without inserting seed data.
CREATE VIEW sonic_bridge_schema AS
SELECT 1 AS singleton, 1 AS version, 'sonic-bridge-owner-state-v1' AS schema_id;

CREATE TABLE sonic_bridge_state (
  owner_hash TEXT NOT NULL PRIMARY KEY
    CHECK (length(owner_hash) = 64 AND owner_hash NOT GLOB '*[^0-9a-f]*'),
  format_version INTEGER NOT NULL CHECK (typeof(format_version) = 'integer' AND format_version = 1),
  revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision BETWEEN 1 AND 9007199254740991),
  key_id TEXT NOT NULL CHECK (length(key_id) BETWEEN 1 AND 64 AND key_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  nonce TEXT NOT NULL CHECK (length(nonce) = 16 AND nonce NOT GLOB '*[^A-Za-z0-9+/]*'),
  ciphertext TEXT NOT NULL CHECK (length(ciphertext) BETWEEN 24 AND 349548 AND ciphertext NOT GLOB '*[^A-Za-z0-9+/=]*'),
  updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer' AND updated_at BETWEEN 0 AND 9007199254740991)
);
