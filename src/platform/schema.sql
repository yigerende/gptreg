CREATE TABLE IF NOT EXISTS platform_users (
 id text PRIMARY KEY, email text UNIQUE NOT NULL, name text NOT NULL, password_hash text NOT NULL,
 role text NOT NULL DEFAULT 'member' CHECK(role IN ('admin','member')),
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
 points integer NOT NULL DEFAULT 0 CHECK(points>=0), frozen integer NOT NULL DEFAULT 0 CHECK(frozen>=0),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS platform_sessions (hash text PRIMARY KEY,user_id text NOT NULL REFERENCES platform_users(id),expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS platform_api_keys (
 id text PRIMARY KEY,user_id text NOT NULL REFERENCES platform_users(id),name text NOT NULL,hash text UNIQUE NOT NULL,
 prefix text NOT NULL,scopes jsonb NOT NULL,revoked boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS platform_settings (id integer PRIMARY KEY CHECK(id=1),value jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS platform_email_codes (
 email text NOT NULL,purpose text NOT NULL,hash text NOT NULL,attempts integer NOT NULL DEFAULT 0,
 expires_at timestamptz NOT NULL,sent_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(email,purpose)
);
ALTER TABLE platform_email_codes ADD COLUMN IF NOT EXISTS challenge_id text NOT NULL DEFAULT '';
ALTER TABLE platform_email_codes ADD COLUMN IF NOT EXISTS user_id text NOT NULL DEFAULT '';
ALTER TABLE platform_email_codes ADD COLUMN IF NOT EXISTS credential_hash text NOT NULL DEFAULT '';
ALTER TABLE platform_email_codes ADD COLUMN IF NOT EXISTS delivered boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS platform_rate_limits (key text PRIMARY KEY,hits integer NOT NULL,expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS platform_orders (
 id text PRIMARY KEY,user_id text NOT NULL REFERENCES platform_users(id),quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 1000),
 need_oauth boolean NOT NULL,unit_price integer NOT NULL CHECK(unit_price>=0),
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','review','completed','partial','failed','cancelled')),
 delivered integer NOT NULL DEFAULT 0,charged integer NOT NULL DEFAULT 0,released integer NOT NULL DEFAULT 0,
 cancel_requested boolean NOT NULL DEFAULT false,source text NOT NULL,request_key text NOT NULL,request_hash text NOT NULL,
 template jsonb NOT NULL,attempt_limit integer NOT NULL,timeout_minutes integer NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),last_scheduled_at timestamptz,
 UNIQUE(user_id,request_key)
);
CREATE TABLE IF NOT EXISTS platform_items (
 id text PRIMARY KEY,order_id text NOT NULL REFERENCES platform_orders(id),position integer NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','oauth_pending','review','delivered','failed','cancelled')),
 attempts integer NOT NULL DEFAULT 0,oauth_attempts integer NOT NULL DEFAULT 0,asset_id text,
 run_id text UNIQUE,stage text NOT NULL DEFAULT 'register',message text NOT NULL DEFAULT '',
 attempt_started_at timestamptz,available_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(order_id,position)
);
ALTER TABLE platform_orders ADD COLUMN IF NOT EXISTS registration_region text;
-- Existing orders keep their original budget; new orders snapshot the setting.
ALTER TABLE platform_orders ADD COLUMN IF NOT EXISTS resource_retry_limit integer NOT NULL DEFAULT 0;
ALTER TABLE platform_items ADD COLUMN IF NOT EXISTS resource_replacements integer NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS platform_attempts (
 id text PRIMARY KEY,item_id text NOT NULL REFERENCES platform_items(id),run_id text UNIQUE NOT NULL,
 stage text NOT NULL,status text NOT NULL DEFAULT 'starting',created_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz
);
CREATE TABLE IF NOT EXISTS platform_accounts (
 id text PRIMARY KEY,user_id text NOT NULL REFERENCES platform_users(id),order_id text NOT NULL REFERENCES platform_orders(id),
 item_id text UNIQUE NOT NULL REFERENCES platform_items(id),asset_id text UNIQUE NOT NULL,email text UNIQUE NOT NULL,
 need_oauth boolean NOT NULL,credentials text NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS platform_ledger (
 id text PRIMARY KEY,user_id text NOT NULL REFERENCES platform_users(id),reference text NOT NULL,kind text NOT NULL,
 points_delta integer NOT NULL,frozen_delta integer NOT NULL,note text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(user_id,reference)
);
CREATE TABLE IF NOT EXISTS platform_redeem_codes (
 id text PRIMARY KEY,hash text UNIQUE NOT NULL,prefix text NOT NULL,points integer NOT NULL CHECK(points>0),
 redeemed_by text REFERENCES platform_users(id),disabled boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now(),redeemed_at timestamptz
);
CREATE INDEX IF NOT EXISTS platform_redeem_used_at ON platform_redeem_codes(redeemed_at DESC,id DESC) WHERE redeemed_by IS NOT NULL;
CREATE TABLE IF NOT EXISTS platform_audit (id bigserial PRIMARY KEY,actor_id text,action text NOT NULL,target text,detail text NOT NULL DEFAULT '',created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS platform_worker (id integer PRIMARY KEY CHECK(id=1),heartbeat timestamptz NOT NULL,error text NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS platform_order_owner ON platform_orders(user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS platform_item_queue ON platform_items(status,available_at);
CREATE INDEX IF NOT EXISTS platform_account_owner ON platform_accounts(user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS platform_ledger_owner ON platform_ledger(user_id,created_at DESC);

CREATE TABLE IF NOT EXISTS platform_mail_logs (id bigserial PRIMARY KEY,recipient text NOT NULL,purpose text NOT NULL,status text NOT NULL,detail text NOT NULL DEFAULT '',created_at timestamptz NOT NULL DEFAULT now());

ALTER TABLE platform_attempts ADD COLUMN IF NOT EXISTS error_code text NOT NULL DEFAULT '';
ALTER TABLE platform_attempts ADD COLUMN IF NOT EXISTS error_category text NOT NULL DEFAULT '';
ALTER TABLE platform_attempts ADD COLUMN IF NOT EXISTS error_detail text NOT NULL DEFAULT '';
ALTER TABLE platform_attempts ADD COLUMN IF NOT EXISTS cost_snapshot jsonb;
ALTER TABLE platform_attempts ADD COLUMN IF NOT EXISTS cost_checked_at timestamptz;
CREATE INDEX IF NOT EXISTS platform_attempt_item ON platform_attempts(item_id);
ALTER TABLE platform_items ADD COLUMN IF NOT EXISTS execution_started_at timestamptz;
ALTER TABLE platform_items ADD COLUMN IF NOT EXISTS recovery_attempts integer NOT NULL DEFAULT 0;
UPDATE platform_items i SET execution_started_at=COALESCE(
 (SELECT min(a.created_at) FROM platform_attempts a WHERE a.item_id=i.id),i.attempt_started_at)
 WHERE execution_started_at IS NULL AND attempt_started_at IS NOT NULL;
CREATE TABLE IF NOT EXISTS platform_run_cleanup (
 run_id text PRIMARY KEY,item_id text NOT NULL REFERENCES platform_items(id),
 attempts integer NOT NULL DEFAULT 0,next_attempt_at timestamptz NOT NULL DEFAULT now(),
 last_error text NOT NULL DEFAULT '',finished_at timestamptz
);
CREATE TABLE IF NOT EXISTS platform_quarantined_assets (
 asset_id text PRIMARY KEY,item_id text NOT NULL REFERENCES platform_items(id),run_id text NOT NULL,
 reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE platform_accounts ADD COLUMN IF NOT EXISTS engine_sold_at timestamptz;
ALTER TABLE platform_accounts ADD COLUMN IF NOT EXISTS engine_sold_retry_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS platform_account_sold_pending ON platform_accounts(engine_sold_retry_at,id) WHERE engine_sold_at IS NULL;

ALTER TABLE platform_ledger ADD COLUMN IF NOT EXISTS points_after integer;
ALTER TABLE platform_ledger ADD COLUMN IF NOT EXISTS frozen_after integer;
ALTER TABLE platform_redeem_codes ADD COLUMN IF NOT EXISTS encrypted_code text;
ALTER TABLE platform_redeem_codes ADD COLUMN IF NOT EXISTS batch text NOT NULL DEFAULT '';
ALTER TABLE platform_redeem_codes ADD COLUMN IF NOT EXISTS expires_at timestamptz;
