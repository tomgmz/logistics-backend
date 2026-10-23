-- IT Admin handover with a 30-day render period (2026-10-24).
--
-- The handover used to be an instant swap run by the root Company Administrator:
-- the outgoing IT Admin was deactivated in the same transaction that created the
-- successor. Now the outgoing IT Admin runs it themselves: they create the
-- successor's account and keep working alongside them for a 30-day render
-- period, after which the it-admin-render scheduler deactivates them.
--
-- users.render_ends_at marks an IT Admin who is serving that period. It stays
-- set after the scheduler deactivates them, as the record of when they left.
--
-- The one-active-IT-Admin rule becomes one active IT Admin NOT in a render
-- period: the seat holder. A rendering predecessor is still active (can sign in,
-- sees the password reset queue) but no longer counts, which is exactly what
-- lets both be active during the overlap. The staff reset queue is never
-- unstaffed: the successor is active from the moment the handover commits.

alter table public.users
  add column if not exists render_ends_at timestamptz;

comment on column public.users.render_ends_at is
  'IT Admin only: set when they hand the role over; they stay active until this moment, then the it-admin-render scheduler deactivates them.';

drop index if exists public.users_one_active_it_admin;

create unique index users_one_active_it_admin
  on public.users (role)
  where role = 'it_admin' and status = 'active' and render_ends_at is null;

-- The swap, now with the outgoing IT Admin kept active for the render period
-- instead of deactivated. Same shape and same compensation contract as before:
-- the caller creates the Supabase Auth identity first and deletes it again if
-- this raises.
drop function if exists public.transition_it_admin(uuid, uuid, text, text, text, text, text, text, uuid);

create or replace function public.transition_it_admin(
  p_outgoing_id uuid,
  p_incoming_id uuid,
  p_email       text,
  p_first_name  text,
  p_last_name   text,
  p_middle_name text default null,
  p_suffix      text default null,
  p_phone       text default null,
  p_created_by  uuid default null,
  p_render_days integer default 30
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
  -- Lock the outgoing row first, so two handovers racing each other queue up.
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
  -- Already handed over: they are not the seat holder any more.
  IF v_outgoing.render_ends_at IS NOT NULL THEN
    RAISE EXCEPTION 'OUTGOING_ALREADY_RENDERING' USING ERRCODE = 'P0001';
  END IF;

  -- Vacate the seat before filling it again; both commit together.
  UPDATE public.users
     SET render_ends_at = now() + make_interval(days => p_render_days),
         updated_at     = now()
   WHERE user_id = p_outgoing_id;

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

revoke all on function public.transition_it_admin(uuid, uuid, text, text, text, text, text, text, uuid, integer) from public, anon, authenticated;
