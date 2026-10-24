-- The approver's remarks when approving a booking, required on approval from
-- either the General Manager (PATCH /booking/:id/gm-review) or the Company
-- Administrator approving on their own authority (PATCH /booking/:id/status).
--
-- The approval counterpart of rejection_reason. Shown to the client in their
-- transaction history and to staff on the Approvals card of the admin
-- transaction history. Null on bookings approved before this existed, on
-- auto-approved bookings (no General Manager staffed), and on rejected ones.
-- A resubmission clears it along with the rest of the earlier decision.
ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS approval_remarks text;
