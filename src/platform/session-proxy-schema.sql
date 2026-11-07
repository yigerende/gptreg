CREATE TABLE IF NOT EXISTS session_proxy_config_versions (
  version_id TEXT PRIMARY KEY CHECK (version_id <> ''),
  provider_ref TEXT NOT NULL DEFAULT 'iproyal-main',
  auth_type TEXT NOT NULL CHECK (auth_type IN ('credentials','subuser')),
  snapshot_enc TEXT NOT NULL CHECK (snapshot_enc <> ''),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS session_proxy_controls (
  provider_ref TEXT PRIMARY KEY CHECK (provider_ref = 'iproyal-main'),
  active_version TEXT REFERENCES session_proxy_config_versions(version_id),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  revoked BOOLEAN NOT NULL DEFAULT FALSE,
  max_parallel INTEGER NOT NULL DEFAULT 20 CHECK (max_parallel BETWEEN 1 AND 100),
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  synced_at TIMESTAMPTZ,
  checked_at TIMESTAMPTZ,
  last_error TEXT NOT NULL DEFAULT '',
  CHECK (NOT enabled OR active_version IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS session_proxy_regions (
  code TEXT PRIMARY KEY CHECK (code ~ '^[A-Z]{2}$'),
  provider_ref TEXT NOT NULL REFERENCES session_proxy_controls(provider_ref),
  name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 10000,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  suppressed BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (NOT (enabled AND suppressed))
);

CREATE TABLE IF NOT EXISTS session_proxy_task_items (
  source TEXT NOT NULL CHECK (source IN ('order','engine','test')),
  task_item_id TEXT NOT NULL CHECK (task_item_id <> ''),
  task_kind TEXT NOT NULL CHECK (task_kind IN ('register','oauth','test')),
  current_attempt_seq INTEGER NOT NULL DEFAULT 1 CHECK (current_attempt_seq > 0),
  policy_snapshot JSONB NOT NULL CHECK (jsonb_typeof(policy_snapshot) = 'object'),
  order_id TEXT,
  customer_user_id TEXT,
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source, task_item_id),
  CHECK ((source = 'test') = (task_kind = 'test'))
);

CREATE TABLE IF NOT EXISTS session_proxy_attempts (
  source TEXT NOT NULL,
  task_item_id TEXT NOT NULL,
  attempt_seq INTEGER NOT NULL CHECK (attempt_seq > 0),
  config_version TEXT NOT NULL REFERENCES session_proxy_config_versions(version_id),
  country TEXT NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
  protocol TEXT NOT NULL CHECK (protocol IN ('http','socks5')),
  final_account_id TEXT CHECK (final_account_id IS NULL OR final_account_id <> ''),
  registration_started_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source, task_item_id, attempt_seq),
  FOREIGN KEY (source, task_item_id)
    REFERENCES session_proxy_task_items(source, task_item_id),
  UNIQUE (source, task_item_id, attempt_seq, config_version, country, protocol)
);

CREATE TABLE IF NOT EXISTS session_proxy_sessions (
  session_id TEXT PRIMARY KEY CHECK (session_id ~ '^[A-Za-z0-9]{8}$'),
  source TEXT NOT NULL,
  task_item_id TEXT NOT NULL,
  attempt_seq INTEGER NOT NULL,
  config_version TEXT NOT NULL,
  country TEXT NOT NULL,
  protocol TEXT NOT NULL,
  endpoint_enc TEXT NOT NULL CHECK (endpoint_enc <> ''),
  generated_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (source, task_item_id, attempt_seq, config_version, country, protocol)
    REFERENCES session_proxy_attempts
      (source, task_item_id, attempt_seq, config_version, country, protocol),
  UNIQUE (session_id, source, task_item_id, attempt_seq, config_version, country, protocol),
  CHECK (expires_at > generated_at)
);

CREATE TABLE IF NOT EXISTS session_proxy_bindings (
  id BIGSERIAL PRIMARY KEY,
  source TEXT NOT NULL,
  task_item_id TEXT NOT NULL,
  attempt_seq INTEGER NOT NULL,
  config_version TEXT NOT NULL,
  country TEXT NOT NULL,
  protocol TEXT NOT NULL,
  session_ref TEXT,
  execution_id UUID NOT NULL,
  owner_epoch BIGINT NOT NULL DEFAULT 1 CHECK (owner_epoch > 0),
  process_instance_id TEXT NOT NULL CHECK (process_instance_id <> ''),
  final_account_id TEXT CHECK (final_account_id IS NULL OR final_account_id <> ''),
  status TEXT NOT NULL DEFAULT 'reserved'
    CHECK (status IN ('reserved','active','stopping','ended','expired','failed')),
  reserved_until TIMESTAMPTZ NOT NULL,
  heartbeat_at TIMESTAMPTZ,
  lease_until TIMESTAMPTZ,
  activated_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  last_error TEXT NOT NULL DEFAULT '',
  detect_result JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (source, task_item_id, attempt_seq, config_version, country, protocol)
    REFERENCES session_proxy_attempts
      (source, task_item_id, attempt_seq, config_version, country, protocol),
  FOREIGN KEY (session_ref, source, task_item_id, attempt_seq, config_version, country, protocol)
    REFERENCES session_proxy_sessions
      (session_id, source, task_item_id, attempt_seq, config_version, country, protocol),
  CHECK (reserved_until > created_at),
  CHECK ((status IN ('ended','expired','failed')) = (ended_at IS NOT NULL)),
  CHECK (status <> 'active' OR
    (session_ref IS NOT NULL AND activated_at IS NOT NULL
     AND heartbeat_at IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK (activated_at IS NULL OR session_ref IS NOT NULL),
  CHECK (jsonb_typeof(detect_result) = 'object')
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_session_task_live
  ON session_proxy_bindings(source, task_item_id)
  WHERE status IN ('reserved','active','stopping');
CREATE UNIQUE INDEX IF NOT EXISTS uq_session_live
  ON session_proxy_bindings(session_ref)
  WHERE status IN ('reserved','active','stopping') AND session_ref IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_session_asset_live
  ON session_proxy_bindings(final_account_id)
  WHERE status IN ('reserved','active','stopping') AND final_account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_session_binding_status
  ON session_proxy_bindings(status, reserved_until);
CREATE INDEX IF NOT EXISTS idx_session_binding_account
  ON session_proxy_bindings(final_account_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_session_binding_history
  ON session_proxy_bindings(source, task_item_id, attempt_seq, id DESC);

CREATE TABLE IF NOT EXISTS platform_account_execution_claims (
  asset_id TEXT PRIMARY KEY CHECK (asset_id <> ''),
  execution_id UUID NOT NULL,
  process_instance_id TEXT NOT NULL CHECK (process_instance_id <> ''),
  owner_epoch BIGINT NOT NULL CHECK (owner_epoch > 0),
  heartbeat_at TIMESTAMPTZ NOT NULL,
  lease_until TIMESTAMPTZ NOT NULL,
  stopping BOOLEAN NOT NULL DEFAULT FALSE
);
INSERT INTO session_proxy_controls(provider_ref) VALUES('iproyal-main') ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS session_proxy_instances (
 id text PRIMARY KEY, lock_key bigserial UNIQUE, kind text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), stopped_at timestamptz
);
CREATE TABLE IF NOT EXISTS session_proxy_exit_claims (
 exit_ip text PRIMARY KEY, binding_id bigint UNIQUE NOT NULL REFERENCES session_proxy_bindings(id)
);
ALTER TABLE session_proxy_attempts ADD COLUMN IF NOT EXISTS identity_key text;
ALTER TABLE session_proxy_sessions ADD COLUMN IF NOT EXISTS retired_at timestamptz;
ALTER TABLE session_proxy_bindings ADD COLUMN IF NOT EXISTS run_id text;
ALTER TABLE session_proxy_bindings ADD COLUMN IF NOT EXISTS initiated_by text;
