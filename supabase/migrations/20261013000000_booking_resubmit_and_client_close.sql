-- A booking turned down by 8338 (General Manager or Company Administrator) is
-- no longer a dead end for the client: they either edit it and resubmit it for
-- a fresh review, or cancel it for good.
--
-- `client_closed_at` marks the second choice. The booking was already
-- 'cancelled' by the rejection itself, so status alone cannot tell "rejected,
-- waiting on the client" apart from "rejected, and the client let it go"; this
-- stamp is what takes it off the client's Needs Your Attention list and hides
-- the Edit & Resubmit button.
--
-- `resubmission_count` lets staff see that a booking in their approval queue is
-- a corrected one rather than a brand-new request.

alter table public.bookings
  add column if not exists client_closed_at   timestamptz,
  add column if not exists resubmission_count integer not null default 0;
