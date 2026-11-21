-- The driver asks the office to resume a paused delivery (2026-11-21, "option C").
--
-- Only the Operations Manager and the Company Administrator end a pause. The
-- driver often knows first that the road is open or the bay has opened, and
-- until now their only way to say so was a phone call. From the paused banner
-- the driver now sends "Ready to continue" (with an optional note); the office
-- answers by ending the pause as before, or "Not yet" with a reason that goes
-- back to the driver. The pause itself never ends without the office.
--
-- One request at a time per pause. A request is open when resume_requested_at
-- is set and there is no "Not yet" after it (resume_declined_at is null or
-- older). A new request after a "Not yet" overwrites the request fields; the
-- audit log keeps every request and answer.
--
-- pause-continuation.scheduler.ts reminds the office every 15 min while a
-- request waits (resume_request_reminded_at), and tells the General Manager
-- once after an hour (resume_request_gm_for = the request it was sent for).

ALTER TABLE public.booking_pauses
  ADD COLUMN IF NOT EXISTS resume_requested_at        timestamptz,
  ADD COLUMN IF NOT EXISTS resume_requested_by        uuid,
  ADD COLUMN IF NOT EXISTS resume_request_note        text,
  ADD COLUMN IF NOT EXISTS resume_request_reminded_at timestamptz,
  ADD COLUMN IF NOT EXISTS resume_request_gm_for      timestamptz,
  ADD COLUMN IF NOT EXISTS resume_declined_at         timestamptz,
  ADD COLUMN IF NOT EXISTS resume_declined_by         uuid,
  ADD COLUMN IF NOT EXISTS resume_decline_note        text;

-- Named, so every embed can say which user it means (booking_pauses already has
-- several user references).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'booking_pauses_resume_requested_by_fkey') THEN
    ALTER TABLE public.booking_pauses
      ADD CONSTRAINT booking_pauses_resume_requested_by_fkey
      FOREIGN KEY (resume_requested_by) REFERENCES public.users(user_id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'booking_pauses_resume_declined_by_fkey') THEN
    ALTER TABLE public.booking_pauses
      ADD CONSTRAINT booking_pauses_resume_declined_by_fkey
      FOREIGN KEY (resume_declined_by) REFERENCES public.users(user_id) ON DELETE SET NULL;
  END IF;
END $$;

ALTER TABLE public.booking_pauses
  DROP CONSTRAINT IF EXISTS booking_pauses_resume_request_note_len;
ALTER TABLE public.booking_pauses
  ADD CONSTRAINT booking_pauses_resume_request_note_len CHECK (resume_request_note IS NULL OR char_length(resume_request_note) <= 300);
ALTER TABLE public.booking_pauses
  DROP CONSTRAINT IF EXISTS booking_pauses_resume_decline_note_len;
ALTER TABLE public.booking_pauses
  ADD CONSTRAINT booking_pauses_resume_decline_note_len CHECK (resume_decline_note IS NULL OR char_length(resume_decline_note) <= 500);

COMMENT ON COLUMN public.booking_pauses.resume_requested_at IS
  'The driver pressed "Ready to continue" (latest request). Open while resume_declined_at is null or older.';
COMMENT ON COLUMN public.booking_pauses.resume_decline_note IS
  'The office''s "Not yet" reason, sent to the driver. Staff and driver only, never the client.';
