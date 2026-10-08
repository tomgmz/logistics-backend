-- Completion is the client's alone. Staff can no longer confirm a delivered
-- booking on the client's behalf; it completes only when the client confirms it,
-- or automatically three days after delivery.
--
-- That left a reported problem with no way out, since a report holds the
-- auto-complete. Staff now mark the problem resolved instead: the report stays
-- on the booking for the record, and the client gets a fresh three days to
-- confirm (or report again) from the moment it was resolved.

ALTER TABLE public.bookings
  -- When staff marked the client's reported problem resolved. Restarts the
  -- 3-day clock from here. Cleared if the client reports a problem again.
  ADD COLUMN IF NOT EXISTS client_issue_resolved_at  timestamptz,
  ADD COLUMN IF NOT EXISTS client_issue_resolved_by  uuid REFERENCES public.users(user_id) ON DELETE SET NULL;

-- The scheduler's queue is now every delivered booking with no OPEN problem,
-- which a partial index on "never reported" no longer covers.
DROP INDEX IF EXISTS public.idx_bookings_delivered_awaiting_confirmation;
CREATE INDEX IF NOT EXISTS idx_bookings_delivered_awaiting_confirmation
  ON public.bookings (delivered_at)
  WHERE status = 'delivered';

COMMENT ON COLUMN public.bookings.client_issue_resolved_at IS
  'When staff marked the client''s reported problem resolved. The booking then completes on client confirmation, or automatically 3 days after this.';
COMMENT ON COLUMN public.bookings.client_issue_note IS
  'What the client reported as wrong with the delivery instead of confirming it. Holds auto-completion until staff mark it resolved.';
