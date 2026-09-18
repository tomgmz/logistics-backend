-- Hand the IT Admin role from one person to the next, atomically.
--
-- A resignation is the dangerous moment for this role. The obvious sequence --
-- remove the leaver, then create the successor -- opens a window with no active
-- IT Admin, and during that window every staff password reset is both invisible
-- (recipient lookups filter on status = 'active') and unactionable (a Company
-- Admin is refused by assertOwnsRequest). See 20260916010000_one_active_it_admin.
--
-- The window cannot be closed from application code: supabase-js talks to
-- PostgREST, which has no multi-statement transaction, so a deactivate followed
-- by an insert is two independent commits with a crash-shaped gap between them.
-- And the gap cannot be avoided by reversing the order either, because the
-- uniqueness rule forbids two active IT Admins existing at once.
--
-- So the swap happens here, where both statements commit together. There is
-- never an instant at which zero rows satisfy the index predicate, and never one
-- at which two do.
--
-- The Supabase Auth identity is the one step that cannot join this transaction.
-- The caller creates it BEFORE calling this function and deletes it again if this
-- function raises -- the same compensation shape createITAdmin already uses.

create or replace function public.transition_it_admin(
  p_outgoing_id uuid,
  p_incoming_id uuid,
  p_email       text,
  p_first_name  text,
  p_last_name   text,
  p_middle_name text default null,
  p_suffix      text default null,
  p_phone       text default null,
  p_created_by  uuid default null
)
returns public.users
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
DECLARE
  v_outgoing public.users;
  v_new      public.users;
BEGIN
  -- Lock the outgoing row before reading its status, so two handovers racing each
  -- other queue up instead of both deciding they are the one doing the swap. The
  -- unique index would catch the loser anyway; this makes it a clean wait rather
  -- than a constraint violation.
  SELECT * INTO v_outgoing
    FROM public.users
   WHERE user_id = p_outgoing_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'OUTGOING_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_outgoing.role <> 'it_admin' THEN
    RAISE EXCEPTION 'OUTGOING_NOT_IT_ADMIN' USING ERRCODE = 'P0001';
  END IF;
  IF v_outgoing.status <> 'active' THEN
    RAISE EXCEPTION 'OUTGOING_NOT_ACTIVE' USING ERRCODE = 'P0001';
  END IF;

  -- Order matters: vacate the unique predicate before filling it again. Both
  -- statements are in one transaction, so the empty moment between them is never
  -- observable from outside.
  --
  -- 'deactivated', not 'archived': the predecessor's record is kept and the
  -- handover stays reversible by reactivating them. Archiving is terminal --
  -- every update path in the codebase carries .neq('status','archived').
  UPDATE public.users
     SET status     = 'deactivated',
         updated_at = now()
   WHERE user_id = p_outgoing_id;

  -- must_change_password is true for the same reason it is on every provisioned
  -- account: the password in the welcome email is ours, not theirs, until they
  -- replace it.
  INSERT INTO public.users (
    user_id, email, first_name, last_name, middle_name, suffix,
    phone, role, status, created_by, must_change_password
  ) VALUES (
    p_incoming_id,
    p_email,
    p_first_name,
    p_last_name,
    p_middle_name,
    p_suffix,
    p_phone,
    'it_admin',
    'active',
    p_created_by,
    true
  )
  RETURNING * INTO v_new;

  RETURN v_new;
END;
$function$;
