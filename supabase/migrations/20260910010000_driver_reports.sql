-- What the driver raises from the road.
--
-- The driver app had a "Maintenance" tab that was a placeholder screen and
-- nothing else; the only vehicle-condition record in the system was the fleet
-- manager's pre-dispatch BLOWBAGETS inspection, taken in the yard before the
-- truck left. Nothing existed for the thing that actually happens — a driver,
-- mid-route, with a problem.
--
-- This is that record. It is deliberately ONE table for two very different
-- gestures, because they are the same fact caught at different speeds:
--
--   * a QUICK ALERT is one tap and a countdown. Location, vehicle and driver are
--     already known, so a row can be written with nothing typed at all — the
--     incident type is optional and the description empty. Speed is the feature;
--     a driver in a real emergency should not be filling in a form.
--   * a DETAILED REPORT is the same row with the fields the driver had time to
--     supply: sub-type, description, photos, a re-check of the vehicle, and
--     whether the trip can carry on.
--
-- Keeping them in one table means operations sees one queue in one order,
-- and a quick alert can be enriched afterwards (the app lets the driver open it
-- again and add detail) rather than becoming a second, duplicate row.

CREATE TABLE IF NOT EXISTS public.driver_reports (
  report_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Who and what. driver_id is NOT NULL — a report with no driver is not a
  -- report — while the booking and truck are nullable: a driver can raise one
  -- in the yard between jobs, and the vehicle is unknown then.
  driver_id  uuid NOT NULL REFERENCES public.drivers(driver_id)   ON DELETE CASCADE,
  booking_id uuid          REFERENCES public.bookings(booking_id) ON DELETE SET NULL,
  truck_id   uuid          REFERENCES public.trucks(truck_id)     ON DELETE SET NULL,

  -- 'quick'    — the SOS path: sent immediately, may carry nothing but a position
  -- 'detailed' — the full form
  source varchar(10) NOT NULL DEFAULT 'detailed'
    CHECK (source IN ('quick', 'detailed')),

  -- NULL is meaningful on a quick alert and is shown as "Unspecified Emergency":
  -- the driver hit send without picking a tile, which is exactly what the
  -- countdown is designed to allow.
  incident_type varchar(30)
    CHECK (incident_type IN ('accident', 'vehicle_breakdown', 'health_emergency', 'security_threat')),

  -- Free text rather than an enum: the sub-type list differs per incident type
  -- and will keep changing (the form's own last option is "Other"). Constraining
  -- it here would mean a migration every time operations reworded a choice.
  sub_type    varchar(100),
  description text,

  -- Cloudinary URLs, same as every other upload in this system — the DB stores
  -- the URL, never the bytes.
  photo_urls text[] NOT NULL DEFAULT '{}',
  video_urls text[] NOT NULL DEFAULT '{}',

  -- Where the driver was when they raised it. Captured on the device at that
  -- moment and sent in the body, for the same reason stop proofs are: by the
  -- time a queued report reaches the server the truck has moved.
  latitude   numeric,
  longitude  numeric,
  accuracy_m numeric,
  address    text,

  -- The driver's own BLOWBAGETS re-check, offered on a breakdown report. Same
  -- JSON shape as bookings.blowbagets_check so both can be read by one helper:
  --   { "items": { "battery": true, ... }, "checked_at": "<iso8601>" }
  -- NULL when the driver did not tick the "include a vehicle check" switch.
  blowbagets_check jsonb,

  -- The single most operationally useful field on the form: does someone need
  -- to be sent out right now, or is the truck still moving? NULL when the
  -- report is not about the trip (or came in as a bare quick alert).
  trip_can_continue boolean,

  -- 'reported'     — nobody has picked it up yet
  -- 'acknowledged' — operations has seen it
  -- 'resolved'     — dealt with
  status varchar(20) NOT NULL DEFAULT 'reported'
    CHECK (status IN ('reported', 'acknowledged', 'resolved')),

  acknowledged_by uuid REFERENCES public.users(user_id) ON DELETE SET NULL,
  acknowledged_at timestamptz,
  resolved_by     uuid REFERENCES public.users(user_id) ON DELETE SET NULL,
  resolved_at     timestamptz,
  resolution_note text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- The driver's own list, newest first — the only query the mobile screen makes.
CREATE INDEX IF NOT EXISTS idx_driver_reports_driver
  ON public.driver_reports (driver_id, created_at DESC);

-- Operations' queue: everything still open, newest first.
CREATE INDEX IF NOT EXISTS idx_driver_reports_open
  ON public.driver_reports (created_at DESC)
  WHERE status <> 'resolved';

CREATE INDEX IF NOT EXISTS idx_driver_reports_booking
  ON public.driver_reports (booking_id)
  WHERE booking_id IS NOT NULL;

-- Same posture as the booking tables: RLS on, no policy, service-role only.
ALTER TABLE public.driver_reports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.driver_reports FROM anon, authenticated;

COMMENT ON TABLE public.driver_reports IS
  'Incidents raised by a driver from the road — the one-tap quick alert and the detailed emergency form are the same row, distinguished by `source`.';
COMMENT ON COLUMN public.driver_reports.incident_type IS
  'NULL on a quick alert sent without picking a tile; shown to operations as "Unspecified Emergency".';
COMMENT ON COLUMN public.driver_reports.trip_can_continue IS
  'The driver''s answer to "can the trip continue?" — false means dispatch someone now.';
