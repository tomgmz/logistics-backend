-- Who made each decision on a booking, in what role, and when.
--
-- Until now a booking recorded THAT it was approved (gm_status) and assigned
-- (ops_status) but not by whom. The approver could be the General Manager or
-- the Company Admin acting on their own authority, and the transaction history
-- has to say which. The actor's role is snapshotted rather than joined at read
-- time, because a person's role can change after the fact and the record must
-- show the role they acted in.
--
-- Rejections by the Company Admin already carry cancelled_by / cancelled_at;
-- a General Manager rejection lands in gm_reviewed_* like an approval does.

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS gm_reviewed_by     uuid REFERENCES public.users(user_id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS gm_reviewed_at     timestamptz,
  ADD COLUMN IF NOT EXISTS gm_reviewed_role   text,
  ADD COLUMN IF NOT EXISTS ops_assigned_by    uuid REFERENCES public.users(user_id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS ops_assigned_at    timestamptz,
  ADD COLUMN IF NOT EXISTS ops_assigned_role  text;

COMMENT ON COLUMN public.bookings.gm_reviewed_by IS
  'Who approved or rejected the booking: the General Manager, or the Company Admin approving on their own authority.';
COMMENT ON COLUMN public.bookings.gm_reviewed_role IS
  'users.role of gm_reviewed_by at the moment of the decision.';
COMMENT ON COLUMN public.bookings.ops_assigned_by IS
  'Who last assigned the driver and vehicle.';
COMMENT ON COLUMN public.bookings.ops_assigned_role IS
  'users.role of ops_assigned_by at the moment of the assignment.';

-- ---------------------------------------------------------------------------
-- Backfill, best effort. Role is the actor's CURRENT role — the only one on
-- record for decisions made before this migration.
-- ---------------------------------------------------------------------------

-- Assignments: the assignment rows already carry assigned_by / assigned_at.
-- The truck row wins over the driver row: a vendor assignment has no truck row
-- but may have a driver row, and a company one always has both.
UPDATE public.bookings b
   SET ops_assigned_by   = a.assigned_by,
       ops_assigned_at   = a.assigned_at,
       ops_assigned_role = u.role
  FROM (
    SELECT DISTINCT ON (booking_id) booking_id, assigned_by, assigned_at
      FROM (
        SELECT booking_id, assigned_by, assigned_at, 0 AS pref FROM public.truck_assignments
        UNION ALL
        SELECT booking_id, assigned_by, assigned_at, 1 AS pref FROM public.driver_assignments
      ) x
     WHERE assigned_by IS NOT NULL
     ORDER BY booking_id, pref, assigned_at DESC
  ) a
  JOIN public.users u ON u.user_id = a.assigned_by
 WHERE b.booking_id = a.booking_id
   AND b.ops_assigned_by IS NULL;

-- Approvals: only the audit trail knows who approved. It has no booking id
-- column, but every approval line starts "Booking <reference> ...", written by
-- gmReviewService (gm_approved / gm_rejected) and by the Company Admin's
-- approve path (booking_approved_to_ops). The earliest decision wins.
UPDATE public.bookings b
   SET gm_reviewed_by   = l.user_id,
       gm_reviewed_at   = l."timestamp",
       gm_reviewed_role = u.role
  FROM (
    SELECT DISTINCT ON (bk.booking_id) bk.booking_id, al.user_id, al."timestamp"
      FROM public.bookings bk
      JOIN public.audit_logs al
        ON al.action IN ('gm_approved', 'gm_rejected', 'booking_approved_to_ops')
       AND al.user_id IS NOT NULL
       AND bk.reference_number IS NOT NULL
       AND al.description LIKE 'Booking ' || bk.reference_number || ' %'
     ORDER BY bk.booking_id, al."timestamp" ASC
  ) l
  JOIN public.users u ON u.user_id = l.user_id
 WHERE b.booking_id = l.booking_id
   AND b.gm_reviewed_by IS NULL;
