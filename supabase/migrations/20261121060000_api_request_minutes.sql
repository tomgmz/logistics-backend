-- How the API is doing, minute by minute: the four signals Google's SRE book
-- and every monitoring tool (Datadog, Grafana) start from — traffic, errors,
-- latency, saturation — so the IT Administrator dashboard can say in plain
-- words "the system answered 99.7% of requests, people waited about 0.3 s"
-- (user 2026-11-21: "make it look like even a person that has no IT knowledge
-- would understand it").
--
-- One row per minute. Counts only: no paths with ids, no user, no IP address
-- (never-log-IPs rule). The backend adds to the minute it is in via
-- record_api_minute(), which is additive so a restart or a second instance
-- adds to the same row instead of overwriting it. Kept 30 days.

CREATE TABLE IF NOT EXISTS public.api_request_minutes (
  minute          timestamptz PRIMARY KEY,
  requests        integer NOT NULL DEFAULT 0,
  -- 5xx: the system failed the request.
  server_errors   integer NOT NULL DEFAULT 0,
  -- 4xx: the request was refused (wrong password, no permission, not found).
  -- Not a system failure; counted so the difference can be explained.
  refused         integer NOT NULL DEFAULT 0,
  total_ms        bigint  NOT NULL DEFAULT 0,
  -- Response-time buckets (mergeable, unlike a percentile).
  under_300ms     integer NOT NULL DEFAULT 0,
  under_1s        integer NOT NULL DEFAULT 0,
  under_3s        integer NOT NULL DEFAULT 0,
  over_3s         integer NOT NULL DEFAULT 0,
  max_ms          integer NOT NULL DEFAULT 0,
  -- A `select` round trip to the database, timed once per minute (saturation:
  -- slow or failing = the database is overloaded or out of connections).
  db_ms           integer,
  db_failed       boolean NOT NULL DEFAULT false
);

ALTER TABLE public.api_request_minutes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.api_request_minutes FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.record_api_minute(
  p_minute timestamptz, p_requests int, p_server_errors int, p_refused int, p_total_ms bigint,
  p_under_300ms int, p_under_1s int, p_under_3s int, p_over_3s int, p_max_ms int,
  p_db_ms int, p_db_failed boolean)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.api_request_minutes AS m
    (minute, requests, server_errors, refused, total_ms, under_300ms, under_1s, under_3s, over_3s, max_ms, db_ms, db_failed)
  VALUES
    (date_trunc('minute', p_minute), p_requests, p_server_errors, p_refused, p_total_ms,
     p_under_300ms, p_under_1s, p_under_3s, p_over_3s, p_max_ms, p_db_ms, COALESCE(p_db_failed, false))
  ON CONFLICT (minute) DO UPDATE SET
    requests      = m.requests      + EXCLUDED.requests,
    server_errors = m.server_errors + EXCLUDED.server_errors,
    refused       = m.refused       + EXCLUDED.refused,
    total_ms      = m.total_ms      + EXCLUDED.total_ms,
    under_300ms   = m.under_300ms   + EXCLUDED.under_300ms,
    under_1s      = m.under_1s      + EXCLUDED.under_1s,
    under_3s      = m.under_3s      + EXCLUDED.under_3s,
    over_3s       = m.over_3s       + EXCLUDED.over_3s,
    max_ms        = GREATEST(m.max_ms, EXCLUDED.max_ms),
    db_ms         = COALESCE(EXCLUDED.db_ms, m.db_ms),
    db_failed     = m.db_failed OR EXCLUDED.db_failed
$$;

REVOKE ALL ON FUNCTION public.record_api_minute(timestamptz, int, int, int, bigint, int, int, int, int, int, int, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_api_minute(timestamptz, int, int, int, bigint, int, int, int, int, int, int, boolean)
  TO service_role;
