-- Separate from delivery data: retention only removes these telemetry records.
CREATE TABLE IF NOT EXISTS platform_risk_settings (
 id integer PRIMARY KEY CHECK(id=1), value jsonb NOT NULL DEFAULT '{}', revision integer NOT NULL DEFAULT 0
);
INSERT INTO platform_risk_settings(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS platform_risk_controls (
 user_id text PRIMARY KEY REFERENCES platform_users(id), paused boolean NOT NULL DEFAULT false,
 paused_until timestamptz, limits jsonb NOT NULL DEFAULT '{}', updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS platform_risk_buckets (
 id text PRIMARY KEY, rule text NOT NULL, subject text NOT NULL, label text NOT NULL,
 user_id text NOT NULL DEFAULT '', key_id text NOT NULL DEFAULT '', hits integer NOT NULL DEFAULT 1,
 window_until timestamptz NOT NULL, blocked_until timestamptz, policy text NOT NULL
);
CREATE INDEX IF NOT EXISTS platform_risk_bucket_expiry ON platform_risk_buckets(blocked_until);
CREATE TABLE IF NOT EXISTS platform_risk_events (
 id bigserial PRIMARY KEY, dedupe text UNIQUE NOT NULL, kind text NOT NULL, category text NOT NULL,
 severity text NOT NULL, message text NOT NULL, operation text NOT NULL DEFAULT '', rule text NOT NULL DEFAULT '',
 user_id text NOT NULL DEFAULT '', key_id text NOT NULL DEFAULT '', account text NOT NULL DEFAULT '',
 source_ip text NOT NULL DEFAULT '', source_verified boolean NOT NULL DEFAULT false, target text NOT NULL DEFAULT '',
 status integer NOT NULL DEFAULT 0, occurrences integer NOT NULL DEFAULT 1,
 first_seen timestamptz NOT NULL DEFAULT now(), last_seen timestamptz NOT NULL DEFAULT now(),
 resolved_at timestamptz, resolved_by text
);
CREATE INDEX IF NOT EXISTS platform_risk_event_time ON platform_risk_events(last_seen DESC,id DESC);
CREATE INDEX IF NOT EXISTS platform_risk_event_owner ON platform_risk_events(user_id,last_seen DESC);
CREATE TABLE IF NOT EXISTS platform_risk_traffic (
 id text NOT NULL, minute timestamptz NOT NULL DEFAULT date_trunc('minute',now()),
 user_id text NOT NULL DEFAULT '', key_id text NOT NULL DEFAULT '', source_ip text NOT NULL DEFAULT '',
 channel text NOT NULL, operation text NOT NULL, requests integer NOT NULL DEFAULT 1,
 errors integer NOT NULL DEFAULT 0, blocked integer NOT NULL DEFAULT 0, duration_ms bigint NOT NULL DEFAULT 0,
 PRIMARY KEY(id,minute)
);
CREATE INDEX IF NOT EXISTS platform_risk_traffic_time ON platform_risk_traffic(minute);
CREATE TABLE IF NOT EXISTS platform_risk_scan (
 id integer PRIMARY KEY CHECK(id=1), last_scan timestamptz NOT NULL DEFAULT 'epoch'
);
INSERT INTO platform_risk_scan(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS platform_risk_conditions (
 id text PRIMARY KEY, episode integer NOT NULL DEFAULT 1, active boolean NOT NULL DEFAULT true,
 seen_at timestamptz NOT NULL DEFAULT now()
);
