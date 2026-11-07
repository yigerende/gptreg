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
ALTER TABLE platform_items ADD COLUMN IF NOT EXISTS engine_cancelled_run_id text NOT NULL DEFAULT '';
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
ALTER TABLE platform_accounts ADD COLUMN IF NOT EXISTS login_tokens_checked_at timestamptz;
ALTER TABLE platform_accounts ADD COLUMN IF NOT EXISTS login_tokens_synced_at timestamptz;
CREATE INDEX IF NOT EXISTS platform_account_tokens_pending ON platform_accounts(login_tokens_checked_at,created_at) WHERE login_tokens_synced_at IS NULL;
ALTER TABLE platform_accounts ADD COLUMN IF NOT EXISTS engine_sold_retry_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS platform_account_sold_pending ON platform_accounts(engine_sold_retry_at,id) WHERE engine_sold_at IS NULL;

ALTER TABLE platform_ledger ADD COLUMN IF NOT EXISTS points_after integer;
ALTER TABLE platform_ledger ADD COLUMN IF NOT EXISTS frozen_after integer;
ALTER TABLE platform_redeem_codes ADD COLUMN IF NOT EXISTS encrypted_code text;
ALTER TABLE platform_redeem_codes ADD COLUMN IF NOT EXISTS batch text NOT NULL DEFAULT '';
ALTER TABLE platform_redeem_codes ADD COLUMN IF NOT EXISTS expires_at timestamptz;

-- New admissions snapshot direct referral eligibility; no historical backfill.
ALTER TABLE platform_users ADD COLUMN IF NOT EXISTS invite_code text NOT NULL DEFAULT md5(random()::text||clock_timestamp()::text);
CREATE UNIQUE INDEX IF NOT EXISTS platform_users_invite_code ON platform_users(invite_code);
ALTER TABLE platform_users ADD COLUMN IF NOT EXISTS invited_by text REFERENCES platform_users(id);
CREATE INDEX IF NOT EXISTS platform_users_invited_by ON platform_users(invited_by);
CREATE TABLE IF NOT EXISTS platform_partner_candidates(
 order_id text PRIMARY KEY REFERENCES platform_orders(id),invitee_id text NOT NULL REFERENCES platform_users(id),inviter_id text NOT NULL REFERENCES platform_users(id),
 rate_percent integer NOT NULL CHECK(rate_percent BETWEEN 1 AND 30),CHECK(invitee_id<>inviter_id)
);
CREATE TABLE IF NOT EXISTS platform_partner_rewards(
 order_id text PRIMARY KEY REFERENCES platform_orders(id),invitee_id text NOT NULL REFERENCES platform_users(id),inviter_id text NOT NULL REFERENCES platform_users(id),
 rate_percent integer NOT NULL,fee integer NOT NULL DEFAULT 0 CHECK(fee>=0),amount integer NOT NULL DEFAULT 0 CHECK(amount>=0),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS platform_partner_rewards_owner ON platform_partner_rewards(inviter_id,invitee_id);
CREATE OR REPLACE FUNCTION platform_partner_admit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE inviter text; joined timestamptz; rules jsonb; rate integer;
BEGIN
 SELECT value->'invitations' INTO rules FROM platform_settings WHERE id=1;
 IF rules->>'enabled' IS DISTINCT FROM 'true' THEN RETURN NEW; END IF;
 SELECT invited_by,created_at INTO inviter,joined FROM platform_users WHERE id=NEW.user_id;
 IF inviter IS NOT NULL AND inviter<>NEW.user_id AND NEW.created_at>=joined THEN
  SELECT (s->>'rate_percent')::int INTO rate FROM jsonb_array_elements(rules->'stages') s
   WHERE NEW.created_at<joined+(s->>'until_days')::int*interval '1 day' ORDER BY (s->>'until_days')::int LIMIT 1;
  IF rate>0 THEN INSERT INTO platform_partner_candidates VALUES(NEW.id,NEW.user_id,inviter,rate) ON CONFLICT DO NOTHING; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION platform_partner_settle() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE candidate platform_partner_candidates; target integer; previous integer; delta integer; balance integer; frozen_balance integer;
BEGIN
 IF NEW.charged<=OLD.charged THEN RETURN NEW; END IF;
 SELECT * INTO candidate FROM platform_partner_candidates WHERE order_id=NEW.id;
 IF NOT FOUND THEN RETURN NEW; END IF;
 target=NEW.charged::bigint*candidate.rate_percent/100;
 INSERT INTO platform_partner_rewards(order_id,invitee_id,inviter_id,rate_percent) VALUES(NEW.id,candidate.invitee_id,candidate.inviter_id,candidate.rate_percent) ON CONFLICT DO NOTHING;
 SELECT amount INTO previous FROM platform_partner_rewards WHERE order_id=NEW.id FOR UPDATE;
 delta=target-previous;
 UPDATE platform_partner_rewards SET fee=NEW.charged,amount=target,updated_at=now() WHERE order_id=NEW.id;
 IF delta>0 THEN
  UPDATE platform_users SET points=points+delta WHERE id=candidate.inviter_id RETURNING points,frozen INTO balance,frozen_balance;
  INSERT INTO platform_ledger(id,user_id,reference,kind,points_delta,frozen_delta,note,points_after,frozen_after)
  VALUES(md5(random()::text||clock_timestamp()::text),candidate.inviter_id,'partner:'||NEW.id||':'||target,'invite_reward',delta,0,'伙伴计划消费奖励',balance,frozen_balance);
 END IF;
 RETURN NEW;
END $$;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='platform_partner_admission' AND tgrelid='platform_orders'::regclass) THEN
  CREATE TRIGGER platform_partner_admission AFTER INSERT ON platform_orders FOR EACH ROW EXECUTE FUNCTION platform_partner_admit();
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='platform_partner_settlement' AND tgrelid='platform_orders'::regclass) THEN
  CREATE TRIGGER platform_partner_settlement AFTER UPDATE OF charged ON platform_orders FOR EACH ROW EXECUTE FUNCTION platform_partner_settle();
 END IF;
END $$;
CREATE TABLE IF NOT EXISTS platform_slider_challenges(id text PRIMARY KEY,binding text NOT NULL,target integer NOT NULL,proof_hash text UNIQUE,created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL);
CREATE INDEX IF NOT EXISTS platform_slider_expiry ON platform_slider_challenges(expires_at);
