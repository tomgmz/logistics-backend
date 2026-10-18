-- A driver's tap whose time had to be moved to fit: after correcting for the
-- phone's clock it still landed in the future, before the step before it, or
-- after the step after it. That only happens when the phone's clock was changed
-- between the tap and the moment it was sent, so the office is shown the flag
-- and can correct the time with a reason.
ALTER TABLE public.stop_milestones
  ADD COLUMN IF NOT EXISTS clock_adjusted boolean NOT NULL DEFAULT false;
