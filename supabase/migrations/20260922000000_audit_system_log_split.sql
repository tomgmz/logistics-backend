-- Splits the single audit_logs feed into two: a business audit trail that the
-- Company Admin reads, and a technical system_logs table that only IT Admin
-- reads.
--
-- Background: audit_logs was originally named system_logs (its primary key is
-- still called system_logs_pkey), and when the audit view was added the old
-- name was reused for a second read model over the SAME table. So "system
-- logs" never had storage of its own. This gives it one.
--
-- Nothing is deleted here. The existing 300-odd audit rows stay in audit_logs;
-- only their log_type is re-labelled, because 'user_activity' was doing two
-- unrelated jobs (a user acting on themselves vs an admin acting on someone
-- else's account) and neither was findable.

-- ---------------------------------------------------------------------------
-- 1. Widen the audit log_type vocabulary
-- ---------------------------------------------------------------------------
-- The CHECK already permitted 'auth' even though nothing ever wrote it. The
-- four new types carve up what 'user_activity' was absorbing.
ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_log_type_check;

ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_log_type_check
  CHECK (log_type IN (
    -- a person acted on their own credentials or session
    'auth',
    -- an admin created/changed/removed somebody else's account
    'user_management',
    -- permissions granted or revoked, and attempts that were refused
    'access_control',
    -- a document or proof photo was attached or removed
    'document_activity',
    -- records left the system in bulk
    'data_export',
    -- pre-existing, unchanged
    'user_activity',
    'admin_activity',
    'vehicle_creation',
    'vehicle_activity',
    'booking',
    'payment',
    'system_error',
    'driver_activity',
    'billing_activity',
    'delivery_activity',
    'maintenance_activity'
  ));

-- ---------------------------------------------------------------------------
-- 2. Re-label the existing user_activity rows
-- ---------------------------------------------------------------------------
-- Self-service credential events. The historic *_link_sent / *_otp_sent rows
-- stay here rather than being moved into system_logs: they are history, and
-- rewriting history across tables would be worse than a slightly impure label.
-- Going forward the code sends the *delivery* of those to system_logs instead.
UPDATE audit_logs
   SET log_type = 'auth'
 WHERE log_type = 'user_activity'
   AND action LIKE 'password_reset_%';

-- A driver setting their own availability is operational, not account admin.
UPDATE audit_logs
   SET log_type = 'driver_activity'
 WHERE log_type = 'user_activity'
   AND action = 'driver_set_availability_days';

-- Everything else under user_activity was an admin acting on an account.
UPDATE audit_logs
   SET log_type = 'user_management'
 WHERE log_type = 'user_activity';

-- ---------------------------------------------------------------------------
-- 3. Drop ip_address — privacy
-- ---------------------------------------------------------------------------
-- Company privacy rules forbid recording where a user connected from. The
-- column has existed since the table was created and logEvent() never filled
-- it: all 311 rows read null, so nothing is lost. It is dropped rather than
-- left empty precisely because an empty PII column invites someone to "fix"
-- it later. The controller-side plumbing that collected an IP and then
-- discarded it has been removed in the same change.
ALTER TABLE audit_logs DROP COLUMN IF EXISTS ip_address;

-- ---------------------------------------------------------------------------
-- 4. Indexes for the two things the audit UI actually does
-- ---------------------------------------------------------------------------
-- findAll() orders by timestamp and optionally filters on log_type. Neither
-- had an index; the table was small enough that nobody noticed, and it only
-- grows from here.
CREATE INDEX IF NOT EXISTS audit_logs_timestamp_idx
  ON audit_logs (timestamp DESC);
CREATE INDEX IF NOT EXISTS audit_logs_log_type_timestamp_idx
  ON audit_logs (log_type, timestamp DESC);

-- ---------------------------------------------------------------------------
-- 5. system_logs — what the software did, as opposed to what a person did
-- ---------------------------------------------------------------------------
-- Shape matches the one the IT Admin page already declares, so the frontend
-- types need no reshaping when its stubbed fetch is switched on.
CREATE TABLE IF NOT EXISTS system_logs (
  log_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  log_level   varchar NOT NULL
              CHECK (log_level IN ('info', 'warn', 'error', 'critical')),

  event_type  varchar NOT NULL
              CHECK (event_type IN (
                'server_error',   -- an unhandled throw reached the error handler
                'auth_event',     -- failed login, lockout, token reuse
                'email_event',    -- outbound mail accepted or rejected
                'external_api',   -- Cloudinary, Google Maps, OCR, push
                'cron_job',       -- scheduler ticks, including successful ones
                'db_event'        -- Supabase/Postgres errors, incl. swallowed ones
              )),

  -- Where in the codebase it came from, e.g. 'fleet-recheck.scheduler'. Free
  -- text on purpose: it is a grep target, not a controlled vocabulary.
  source      varchar NOT NULL,
  message     text    NOT NULL,

  -- Stack traces, HTTP status, provider error codes, request ids. Anything
  -- that helps diagnose and nothing that a business reader would need.
  metadata    jsonb,

  -- Present only on this table. Audit history is not "resolvable"; an incident
  -- queue is. Defaults true for info so the unresolved count means "needs a
  -- human", not "has ever happened".
  resolved    boolean NOT NULL DEFAULT false,

  -- Nullable and NOT a foreign key: most rows have no human behind them, and a
  -- row about a failed login must survive the account later being deleted.
  user_id     uuid,

  timestamp   timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS system_logs_timestamp_idx
  ON system_logs (timestamp DESC);
CREATE INDEX IF NOT EXISTS system_logs_event_type_timestamp_idx
  ON system_logs (event_type, timestamp DESC);
CREATE INDEX IF NOT EXISTS system_logs_level_timestamp_idx
  ON system_logs (log_level, timestamp DESC);
-- Drives the "unresolved" stat tile and the default triage view.
CREATE INDEX IF NOT EXISTS system_logs_unresolved_idx
  ON system_logs (timestamp DESC) WHERE resolved = false;

-- info rows are a heartbeat, not a task: they are born resolved so they never
-- inflate the unresolved count the IT Admin triages against.
CREATE OR REPLACE FUNCTION system_logs_autoresolve_info()
RETURNS trigger AS $$
BEGIN
  IF NEW.log_level = 'info' THEN
    NEW.resolved := true;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS system_logs_autoresolve_info_trg ON system_logs;
CREATE TRIGGER system_logs_autoresolve_info_trg
  BEFORE INSERT ON system_logs
  FOR EACH ROW EXECUTE FUNCTION system_logs_autoresolve_info();

-- The service role is the only writer; PostgREST anon/authenticated must not
-- reach either table directly.
ALTER TABLE system_logs ENABLE ROW LEVEL SECURITY;
