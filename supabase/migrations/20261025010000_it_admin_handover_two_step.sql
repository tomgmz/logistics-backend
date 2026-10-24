-- IT Administrator handover in two steps (2026-10-25, replaces transition_it_admin).
--
-- 1. The IT Admin starts the handover: their 30-day render begins
--    (users.render_ends_at), with or without a successor named yet.
-- 2. They add the successor whenever one is found (at the start, or later): an
--    it_admin account created with an emailed temporary password.
-- 3. The successor confirms by signing in and setting their own password (or the
--    emailed-code reset). That ends the render at once and the outgoing account
--    is archived by the service.
--
-- The 30 days is a target, not a deadline: with no confirmed successor the
-- outgoing IT Admin simply stays active (there must never be zero). Nothing is
-- closed on a timer any more.
--
-- users_one_active_it_admin (active, render_ends_at null) is unchanged: the
-- outgoing account renders, so the successor can be inserted as the one
-- non-rendering IT Admin, and the outgoing stays active until confirmation.

create table if not exists public.it_admin_handovers (
  handover_id        uuid primary key default gen_random_uuid(),
  outgoing_id        uuid not null references public.users(user_id) on delete cascade,
  reason             text not null,
  started_at         timestamptz not null default now(),
  -- The target end of the render; past it the render shows as overdue.
  render_due_at      timestamptz not null,
  successor_id       uuid references public.users(user_id) on delete set null,
  successor_added_at timestamptz,
  -- When the successor set their own password: the render ends here.
  confirmed_at       timestamptz,
  ended_at           timestamptz,
  cancelled_at       timestamptz,
  created_by         uuid references public.users(user_id) on delete set null,
  created_at         timestamptz not null default now()
);

-- One handover in progress at a time.
create unique index if not exists it_admin_handovers_one_open
  on public.it_admin_handovers ((true))
  where ended_at is null and cancelled_at is null;

create index if not exists it_admin_handovers_successor
  on public.it_admin_handovers (successor_id)
  where ended_at is null and cancelled_at is null;

alter table public.it_admin_handovers enable row level security;

comment on table public.it_admin_handovers is
  'IT Administrator handovers: started by the outgoing IT Admin (30-day render target), successor added at the start or later, ended when the successor sets their own password.';
comment on column public.users.render_ends_at is
  'IT Admin only: set when they start a handover (the 30-day target). They stay active until their successor confirms, even past this date.';

drop function if exists public.transition_it_admin(uuid, uuid, text, text, text, text, text, text, uuid, integer);

-- Step 1: start the render. Run by the outgoing IT Admin on themselves.
create or replace function public.start_it_admin_handover(
  p_outgoing_id uuid,
  p_reason      text,
  p_render_days integer default 30
)
returns public.it_admin_handovers
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
DECLARE
  v_outgoing public.users;
  v_row      public.it_admin_handovers;
BEGIN
  SELECT * INTO v_outgoing FROM public.users WHERE user_id = p_outgoing_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OUTGOING_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_outgoing.role <> 'it_admin' OR v_outgoing.status <> 'active' OR v_outgoing.render_ends_at IS NOT NULL THEN
    RAISE EXCEPTION 'NOT_SEAT_HOLDER' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM public.it_admin_handovers WHERE ended_at IS NULL AND cancelled_at IS NULL) THEN
    RAISE EXCEPTION 'HANDOVER_OPEN' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.users
     SET render_ends_at = now() + make_interval(days => p_render_days),
         updated_at     = now()
   WHERE user_id = p_outgoing_id;

  INSERT INTO public.it_admin_handovers (outgoing_id, reason, render_due_at, created_by)
  VALUES (p_outgoing_id, p_reason, now() + make_interval(days => p_render_days), p_outgoing_id)
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$function$;

-- Step 2: add the successor's account to the open handover.
create or replace function public.add_it_admin_successor(
  p_outgoing_id uuid,
  p_incoming_id uuid,
  p_email       text,
  p_first_name  text,
  p_last_name   text,
  p_middle_name text default null,
  p_suffix      text default null,
  p_phone       text default null
)
returns public.users
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
DECLARE
  v_handover public.it_admin_handovers;
  v_new      public.users;
BEGIN
  SELECT * INTO v_handover FROM public.it_admin_handovers
   WHERE outgoing_id = p_outgoing_id AND ended_at IS NULL AND cancelled_at IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NO_OPEN_HANDOVER' USING ERRCODE = 'P0001';
  END IF;
  IF v_handover.successor_id IS NOT NULL THEN
    RAISE EXCEPTION 'SUCCESSOR_PENDING' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.users (
    user_id, email, first_name, last_name, middle_name, suffix,
    phone, role, status, created_by, must_change_password
  ) VALUES (
    p_incoming_id, p_email, p_first_name, p_last_name, p_middle_name, p_suffix,
    p_phone, 'it_admin', 'active', p_outgoing_id, true
  )
  RETURNING * INTO v_new;

  UPDATE public.it_admin_handovers
     SET successor_id = p_incoming_id, successor_added_at = now()
   WHERE handover_id = v_handover.handover_id;

  RETURN v_new;
END;
$function$;

-- Step 3: the successor confirmed. Returns the outgoing id (null when this user
-- is not the pending successor of an open handover); the service archives it.
create or replace function public.complete_it_admin_handover(p_successor_id uuid)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
DECLARE
  v_handover public.it_admin_handovers;
BEGIN
  SELECT * INTO v_handover FROM public.it_admin_handovers
   WHERE successor_id = p_successor_id AND ended_at IS NULL AND cancelled_at IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  UPDATE public.it_admin_handovers
     SET confirmed_at = now(), ended_at = now()
   WHERE handover_id = v_handover.handover_id;

  RETURN v_handover.outgoing_id;
END;
$function$;

revoke all on function public.start_it_admin_handover(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.add_it_admin_successor(uuid, uuid, text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.complete_it_admin_handover(uuid) from public, anon, authenticated;
