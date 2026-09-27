-- The client, not the driver, decides a booking is complete.
--
-- The driver's last drop-off now moves a booking to 'delivered'. It becomes
-- 'completed' when the client confirms it, when the Company Administrator or
-- Operations Manager confirms on the client's behalf, or automatically three
-- days after delivery if the client has neither confirmed nor reported a
-- problem. A reported problem holds the booking at 'delivered' until staff
-- resolve it by confirming completion.
--
-- The driver and vehicle are still released at 'delivered': the crew's work is
-- over when the cargo is off, and holding them for the client would strand them.

ALTER TABLE public.bookings DROP CONSTRAINT IF EXISTS bookings_status_check;

ALTER TABLE public.bookings ADD CONSTRAINT bookings_status_check
  CHECK (status::text = ANY (ARRAY['pending', 'approved', 'assigned', 'in_transit', 'delivered', 'completed', 'cancelled']));

ALTER TABLE public.bookings
  -- When the driver finished the last drop-off. Starts the 3-day clock.
  ADD COLUMN IF NOT EXISTS delivered_at                  timestamptz,
  -- Who confirmed completion: the client, or staff on their behalf. NULL with a
  -- completed_confirmed_at means it completed automatically.
  ADD COLUMN IF NOT EXISTS completion_confirmed_by       uuid REFERENCES public.users(user_id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS completion_confirmed_role     text,
  ADD COLUMN IF NOT EXISTS completion_confirmed_at       timestamptz,
  ADD COLUMN IF NOT EXISTS completion_auto               boolean NOT NULL DEFAULT false,
  -- A problem the client reported instead of confirming. Holds auto-completion.
  ADD COLUMN IF NOT EXISTS client_issue_note             text,
  ADD COLUMN IF NOT EXISTS client_issue_reported_at      timestamptz,
  ADD COLUMN IF NOT EXISTS client_issue_reported_by      uuid REFERENCES public.users(user_id) ON DELETE SET NULL,
  -- The reminder sent the day before auto-completion, stamped so it goes once.
  ADD COLUMN IF NOT EXISTS completion_reminder_sent_at   timestamptz;

-- The scheduler's question: delivered bookings with no open problem.
CREATE INDEX IF NOT EXISTS idx_bookings_delivered_awaiting_confirmation
  ON public.bookings (delivered_at)
  WHERE status = 'delivered' AND client_issue_reported_at IS NULL;

COMMENT ON COLUMN public.bookings.delivered_at IS
  'When the driver finished the last drop-off. The booking completes on client confirmation, or automatically 3 days after this.';
COMMENT ON COLUMN public.bookings.completion_auto IS
  'True when the booking completed automatically because nobody confirmed within 3 days of delivery.';
COMMENT ON COLUMN public.bookings.client_issue_note IS
  'What the client reported as wrong with the delivery instead of confirming it. Holds auto-completion until staff confirm.';
