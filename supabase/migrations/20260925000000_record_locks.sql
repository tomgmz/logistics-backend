-- Record locks: one staff member edits a record at a time.
--
-- Operations and the Company Admin can both crew a booking; fleet and admin can
-- both edit a truck; two admins can open the same user. Until now every one of
-- those writes was last-writer-wins: two people assigning a driver to the same
-- booking at the same moment both "succeeded", and the second silently replaced
-- the first — along with its crew reservation and the driver's notification.
--
-- A lock row is keyed by (resource_type, resource_id), e.g. ('booking', <uuid>).
-- It is HELD while holder_id is set and expires_at is in the future. Holders
-- renew it with a heartbeat; a tab that dies simply lets it lapse, so nobody is
-- stranded behind a lock that will never be released.
--
-- The row outlives the lock on purpose. write_seq counts successful guarded
-- writes to the record, and last_writer_id says who made the latest one. A
-- screen that loaded seq 4 and later acquires the lock at seq 5 knows its copy
-- is stale and reloads before letting its user edit — that is what stops a
-- stale screen from overwriting a newer change once the lock passes to it.
--
-- Only the API touches this table (service role). RLS is on with no policies,
-- and the functions are not executable by anon/authenticated.

create table if not exists public.record_locks (
  resource_type  text        not null,
  resource_id    text        not null,
  holder_id      uuid        references public.users(user_id) on delete set null,
  holder_name    text,
  acquired_at    timestamptz,
  expires_at     timestamptz,
  write_seq      bigint      not null default 0,
  last_writer_id uuid        references public.users(user_id) on delete set null,
  last_write_at  timestamptz,
  primary key (resource_type, resource_id)
);

alter table public.record_locks enable row level security;

-- Acquire, or renew, a lock. Race-free: the conditional ON CONFLICT update is a
-- single statement, so two callers racing for a free lock cannot both win.
--
-- Returns the lock as it stands afterwards. `acquired` says whether the caller
-- now holds it; when false, holder_* names who does. `was_held` says whether
-- the caller already held it before this call — the write guard uses that to
-- tell a lock it took for one request (release afterwards) from one the
-- caller's screen is holding (leave alone).
--
-- Renewing never shortens a lock: a write guard taking a 30-second lock must
-- not cut down the 60-second lock the same user's screen is heartbeating.
create or replace function public.acquire_record_lock(
  p_type        text,
  p_id          text,
  p_holder      uuid,
  p_holder_name text,
  p_ttl_seconds integer
)
returns table (
  acquired       boolean,
  was_held       boolean,
  holder_id      uuid,
  holder_name    text,
  expires_at     timestamptz,
  write_seq      bigint,
  last_writer_id uuid
)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_new_expiry timestamptz := now() + make_interval(secs => p_ttl_seconds);
  v_was_held   boolean;
  v_row        public.record_locks%rowtype;
begin
  select (l.holder_id = p_holder and l.expires_at > now())
    into v_was_held
    from public.record_locks l
   where l.resource_type = p_type and l.resource_id = p_id;

  insert into public.record_locks as l
         (resource_type, resource_id, holder_id, holder_name, acquired_at, expires_at)
  values (p_type, p_id, p_holder, p_holder_name, now(), v_new_expiry)
  on conflict (resource_type, resource_id) do update
     set holder_id   = excluded.holder_id,
         holder_name = excluded.holder_name,
         acquired_at = case when l.holder_id = excluded.holder_id and l.expires_at > now()
                            then l.acquired_at else now() end,
         expires_at  = case when l.holder_id = excluded.holder_id and l.expires_at > now()
                            then greatest(l.expires_at, excluded.expires_at)
                            else excluded.expires_at end
   where l.holder_id is null
      or l.expires_at is null
      or l.expires_at <= now()
      or l.holder_id = excluded.holder_id
  returning l.* into v_row;

  if found then
    return query select true, coalesce(v_was_held, false), v_row.holder_id, v_row.holder_name,
                        v_row.expires_at, v_row.write_seq, v_row.last_writer_id;
    return;
  end if;

  -- Someone else holds it.
  return query
    select false, false, l.holder_id, l.holder_name, l.expires_at, l.write_seq, l.last_writer_id
      from public.record_locks l
     where l.resource_type = p_type and l.resource_id = p_id;
end;
$$;

-- Release a lock, but only the caller's own. Releasing someone else's lock is
-- a silent no-op rather than an error: a late unload beacon from a tab whose
-- lock already lapsed and passed to a colleague must not take it from them.
create or replace function public.release_record_lock(
  p_type   text,
  p_id     text,
  p_holder uuid
)
returns boolean
language sql
security definer
set search_path = public
as $$
  with released as (
    update public.record_locks
       set holder_id = null, holder_name = null, acquired_at = null, expires_at = null
     where resource_type = p_type and resource_id = p_id and holder_id = p_holder
    returning 1
  )
  select exists (select 1 from released);
$$;

-- Count one successful write to a record.
create or replace function public.bump_record_write(
  p_type   text,
  p_id     text,
  p_writer uuid
)
returns bigint
language sql
security definer
set search_path = public
as $$
  insert into public.record_locks as l (resource_type, resource_id, write_seq, last_writer_id, last_write_at)
  values (p_type, p_id, 1, p_writer, now())
  on conflict (resource_type, resource_id) do update
     set write_seq = l.write_seq + 1, last_writer_id = excluded.last_writer_id, last_write_at = now()
  returning write_seq;
$$;

revoke all on function public.acquire_record_lock(text, text, uuid, text, integer) from public, anon, authenticated;
revoke all on function public.release_record_lock(text, text, uuid)               from public, anon, authenticated;
revoke all on function public.bump_record_write(text, text, uuid)                 from public, anon, authenticated;
grant execute on function public.acquire_record_lock(text, text, uuid, text, integer) to service_role;
grant execute on function public.release_record_lock(text, text, uuid)               to service_role;
grant execute on function public.bump_record_write(text, text, uuid)                 to service_role;
