-- In-app emergency voice calls (LiveKit), placed by a driver right after a
-- quick alert.
--
-- The quick alert is the data. This table is the voice call that follows it.
-- Every active Operations Manager is rung at the same time, or every Company
-- Administrator when there are no Operations Managers. The first to press
-- Answer gets the call. That claim is a conditional UPDATE on `status`, so two
-- managers clicking at the same moment can never both be connected.
--
-- When the in-app call can't connect or nobody answers, the driver's phone
-- falls back to an ordinary call through its dialer. That outcome is recorded
-- here too ('fell_back'), so the desk can see an alert that was followed by a
-- phone call outside the app.

CREATE TABLE IF NOT EXISTS public.emergency_calls (
  call_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The alert this call follows. Kept when the report is removed.
  report_id  uuid REFERENCES public.driver_reports(report_id) ON DELETE SET NULL,
  driver_id  uuid NOT NULL REFERENCES public.drivers(driver_id) ON DELETE CASCADE,
  booking_id uuid REFERENCES public.bookings(booking_id) ON DELETE SET NULL,

  -- The LiveKit room. One room per call, never reused.
  room_name  text NOT NULL UNIQUE,

  -- ringing   — staff browsers are ringing
  -- answered  — a manager picked up; the call is live
  -- ended     — an answered call finished
  -- missed    — nobody answered and the driver did not fall back
  -- fell_back — the in-app call failed or went unanswered and the phone dialled out
  status varchar(12) NOT NULL DEFAULT 'ringing'
    CHECK (status IN ('ringing', 'answered', 'ended', 'missed', 'fell_back')),

  -- Everyone who was rung, so only they can answer and they can be told to stop.
  rung_user_ids uuid[] NOT NULL DEFAULT '{}',

  answered_by uuid REFERENCES public.users(user_id) ON DELETE SET NULL,
  answered_at timestamptz,
  ended_by    uuid REFERENCES public.users(user_id) ON DELETE SET NULL,
  ended_at    timestamptz,
  -- hangup | no_answer | failed | timeout
  end_reason  varchar(20),

  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_emergency_calls_ringing
  ON public.emergency_calls (created_at DESC) WHERE status = 'ringing';
CREATE INDEX IF NOT EXISTS idx_emergency_calls_report
  ON public.emergency_calls (report_id);

-- Same posture as the other operational tables: RLS on, no policy, service-role only.
ALTER TABLE public.emergency_calls ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.emergency_calls IS
  'In-app emergency voice calls a driver placed after a quick alert: who was rung, who answered, and how it ended (including falling back to a phone call).';

-- The truck's speed when the alert went out, from the phone's GPS. Ops read it
-- as "was the truck still moving?" (a rollover at speed vs a stop at the kerb).
ALTER TABLE public.driver_reports ADD COLUMN IF NOT EXISTS speed_kmh numeric;
COMMENT ON COLUMN public.driver_reports.speed_kmh IS
  'GPS speed in km/h at the moment the alert was sent, when the phone had one.';
