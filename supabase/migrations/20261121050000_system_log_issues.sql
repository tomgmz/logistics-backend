-- System log issues: repeated errors are grouped, and the group is what gets
-- resolved (user 2026-11-21: "resolving in logs is not realistic, it is so many").
--
-- Industry practice (Sentry, Datadog Error Tracking, Google Cloud Error
-- Reporting): a log row is an immutable record; error rows with the same
-- fingerprint form ONE issue with a count, first seen and last seen. The issue
-- is resolved, ignored, or reopened by itself when it happens again after being
-- resolved (a "regression"). Info and warning rows are never grouped: they are
-- kept for search and trends, nobody resolves them.
--
-- In production on 2026-11-21: 713 unresolved error/critical rows, 446 of them
-- one Resend 429 burst. As issues that is a few dozen.
--
-- The grouping happens in the database (BEFORE INSERT trigger) so every writer
-- is covered — logSystem(), the email webhook, anything later — and two
-- processes logging the same error at once meet on the unique fingerprint
-- (ON CONFLICT) instead of racing.
--
-- system_logs.resolved stays (reserved-column rule), but nothing reads it for
-- error/critical rows any more; the issue's status is the truth.

-- ---------------------------------------------------------------------------
-- 1. Fingerprint: level + event + source + the message with the variable parts
--    taken out (ids, email addresses, numbers), so "no position for 28 min on
--    booking <id>" and "... 5 min on booking <other id>" are one issue.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.system_log_normalize(p_message text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT left(
    btrim(regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(
            -- An HTML error page (Cloudflare 522 from Supabase): its <title> is the message.
            COALESCE(substring(p_message FROM '(?i)<title>([^<]*)</title>'), left(p_message, 600)),
            '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}', '<id>', 'g'),
          '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', '<email>', 'g'),
        '[0-9]+', '<n>', 'g'),
      '\s+', ' ', 'g')),
    300)
$$;

CREATE OR REPLACE FUNCTION public.system_log_fingerprint(
  p_level text, p_event text, p_source text, p_message text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT md5(p_level || '|' || p_event || '|' || p_source || '|' || public.system_log_normalize(p_message))
$$;

-- ---------------------------------------------------------------------------
-- 2. The issues
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.system_log_issues (
  issue_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fingerprint     text NOT NULL UNIQUE,

  log_level       varchar NOT NULL CHECK (log_level IN ('error', 'critical')),
  event_type      varchar NOT NULL,
  source          varchar NOT NULL,
  -- The normalized message: what every row in the group has in common.
  title           text NOT NULL,
  -- The newest row's full message and id, for the detail view.
  last_message    text NOT NULL,
  last_log_id     uuid,

  status          varchar NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open', 'resolved', 'ignored')),
  event_count     integer NOT NULL DEFAULT 1,
  first_seen      timestamptz NOT NULL DEFAULT now(),
  last_seen       timestamptz NOT NULL DEFAULT now(),

  -- Who closed it. NOT a foreign key (same as system_logs.user_id): the row
  -- must survive the account, and no second users FK to embed around.
  -- NULL with resolution 'auto' = closed by the quiet-for-7-days rule.
  resolved_at     timestamptz,
  resolved_by     uuid,
  resolution      varchar CHECK (resolution IN ('manual', 'auto')),

  -- Ignored until this time; NULL with status 'ignored' = ignored for good.
  ignored_until   timestamptz,
  ignored_by      uuid,

  -- Came back after being resolved.
  regressed_at    timestamptz,
  times_regressed integer NOT NULL DEFAULT 0,

  -- How many rows arrived while it was ignored (shown so ignoring never hides volume).
  count_while_ignored integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS system_log_issues_status_last_seen_idx
  ON public.system_log_issues (status, last_seen DESC);
CREATE INDEX IF NOT EXISTS system_log_issues_level_status_idx
  ON public.system_log_issues (log_level, status);

ALTER TABLE public.system_log_issues ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.system_log_issues FROM anon, authenticated;

-- One FK, named, so an embed can name it.
ALTER TABLE public.system_logs ADD COLUMN IF NOT EXISTS issue_id uuid;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'system_logs_issue_id_fkey') THEN
    ALTER TABLE public.system_logs
      ADD CONSTRAINT system_logs_issue_id_fkey
      FOREIGN KEY (issue_id) REFERENCES public.system_log_issues(issue_id) ON DELETE SET NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS system_logs_issue_id_timestamp_idx
  ON public.system_logs (issue_id, timestamp DESC) WHERE issue_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. Grouping on insert
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.system_logs_group_issue()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_at timestamptz := COALESCE(NEW.timestamp AT TIME ZONE 'UTC', now());
BEGIN
  IF NEW.log_level NOT IN ('error', 'critical') THEN
    RETURN NEW;
  END IF;
  IF NEW.log_id IS NULL THEN
    NEW.log_id := gen_random_uuid();
  END IF;

  -- A grouping failure must never lose the log row itself.
  BEGIN
    INSERT INTO public.system_log_issues AS i
      (fingerprint, log_level, event_type, source, title, last_message, last_log_id, first_seen, last_seen)
    VALUES (
      public.system_log_fingerprint(NEW.log_level, NEW.event_type, NEW.source, NEW.message),
      NEW.log_level, NEW.event_type, NEW.source,
      public.system_log_normalize(NEW.message),
      left(NEW.message, 4000), NEW.log_id, v_at, v_at)
    ON CONFLICT (fingerprint) DO UPDATE SET
      event_count  = i.event_count + 1,
      last_seen    = GREATEST(i.last_seen, EXCLUDED.last_seen),
      last_message = EXCLUDED.last_message,
      last_log_id  = EXCLUDED.last_log_id,
      -- Resolved and it happened again = a regression: reopen. An ignore with
      -- an end time that has passed reopens too; an ignore for good stays.
      status = CASE
        WHEN i.status = 'resolved' THEN 'open'
        WHEN i.status = 'ignored' AND i.ignored_until IS NOT NULL AND i.ignored_until <= now() THEN 'open'
        ELSE i.status END,
      regressed_at    = CASE WHEN i.status = 'resolved' THEN now() ELSE i.regressed_at END,
      times_regressed = i.times_regressed + CASE WHEN i.status = 'resolved' THEN 1 ELSE 0 END,
      resolved_at     = CASE WHEN i.status = 'resolved' THEN NULL ELSE i.resolved_at END,
      resolved_by     = CASE WHEN i.status = 'resolved' THEN NULL ELSE i.resolved_by END,
      resolution      = CASE WHEN i.status = 'resolved' THEN NULL ELSE i.resolution END,
      ignored_until   = CASE WHEN i.status = 'ignored' AND i.ignored_until IS NOT NULL AND i.ignored_until <= now()
                             THEN NULL ELSE i.ignored_until END,
      count_while_ignored = i.count_while_ignored
        + CASE WHEN i.status = 'ignored' AND (i.ignored_until IS NULL OR i.ignored_until > now()) THEN 1 ELSE 0 END
    RETURNING i.issue_id INTO NEW.issue_id;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'system_logs_group_issue failed: %', SQLERRM;
  END;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.system_logs_group_issue() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS system_logs_group_issue_trg ON public.system_logs;
CREATE TRIGGER system_logs_group_issue_trg
  BEFORE INSERT ON public.system_logs
  FOR EACH ROW EXECUTE FUNCTION public.system_logs_group_issue();

-- Issues refresh the IT Administrator screens on their own topic, so an issue
-- update does not count as a "new entry" on the System Logs tab.
DROP TRIGGER IF EXISTS live_signal ON public.system_log_issues;
CREATE TRIGGER live_signal AFTER INSERT OR UPDATE OR DELETE ON public.system_log_issues
  FOR EACH ROW EXECUTE FUNCTION public.live_signal_trigger('issue_id', 'live:system_log_issues');

-- ---------------------------------------------------------------------------
-- 4. Backfill the rows already on record
-- ---------------------------------------------------------------------------
-- Quiet: one broadcast per back-filled row would flood live:system_logs.
ALTER TABLE public.system_logs DISABLE TRIGGER live_signal;

WITH fp AS (
  SELECT log_id, log_level, event_type, source, message, resolved,
         (timestamp AT TIME ZONE 'UTC') AS at,
         public.system_log_fingerprint(log_level, event_type, source, message) AS fingerprint
    FROM public.system_logs
   WHERE log_level IN ('error', 'critical') AND issue_id IS NULL
), grouped AS (
  SELECT DISTINCT ON (fingerprint)
         fingerprint, log_level, event_type, source, message, log_id,
         count(*)        OVER w AS n,
         min(at)         OVER w AS first_at,
         max(at)         OVER w AS last_at,
         bool_and(resolved) OVER w AS all_resolved
    FROM fp
  WINDOW w AS (PARTITION BY fingerprint)
   ORDER BY fingerprint, at DESC
)
INSERT INTO public.system_log_issues
  (fingerprint, log_level, event_type, source, title, last_message, last_log_id,
   status, event_count, first_seen, last_seen, resolved_at, resolution)
SELECT fingerprint, log_level, event_type, source,
       public.system_log_normalize(message), left(message, 4000), log_id,
       CASE WHEN all_resolved THEN 'resolved' ELSE 'open' END,
       n, first_at, last_at,
       CASE WHEN all_resolved THEN now() END,
       CASE WHEN all_resolved THEN 'manual' END
  FROM grouped
ON CONFLICT (fingerprint) DO NOTHING;

UPDATE public.system_logs l
   SET issue_id = i.issue_id
  FROM public.system_log_issues i
 WHERE l.issue_id IS NULL
   AND l.log_level IN ('error', 'critical')
   AND i.fingerprint = public.system_log_fingerprint(l.log_level, l.event_type, l.source, l.message);

ALTER TABLE public.system_logs ENABLE TRIGGER live_signal;
