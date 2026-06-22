-- In-app notifications for the booking approval workflow.
-- Backend writes/reads with the service-role key (same pattern as push_subscriptions),
-- so no RLS policies are added here; all client access goes through the API.
--
-- Written idempotently: a legacy/partial `notifications` table (title/message/
-- is_read shape) is evolved into the full shape, and a fresh database gets the
-- complete table created from scratch.

create table if not exists public.notifications (
  notification_id uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.users(user_id) on delete cascade,
  type          text not null,
  title         text not null,
  created_at    timestamptz not null default now()
);

-- Bring any pre-existing table up to the full shape.
alter table public.notifications add column if not exists body       text;
alter table public.notifications add column if not exists booking_id uuid references public.bookings(booking_id) on delete cascade;
alter table public.notifications add column if not exists data       jsonb not null default '{}';
alter table public.notifications add column if not exists read_at    timestamptz;

-- Migrate the legacy `message`/`is_read` columns into `body`/`read_at`, then drop them.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='notifications' and column_name='message'
  ) then
    update public.notifications set body = coalesce(body, message);
    alter table public.notifications drop column message;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='notifications' and column_name='is_read'
  ) then
    update public.notifications set read_at = case when is_read then now() else read_at end;
    alter table public.notifications drop column is_read;
  end if;
end $$;

-- Drop the legacy type enum CHECK; notification types are now governed by the
-- application's NotificationType union (booking.* values), not the DB.
alter table public.notifications drop constraint if exists notifications_type_check;

-- Normalize created_at to timestamptz so clients parse it as UTC.
alter table public.notifications
  alter column created_at type timestamptz using created_at at time zone 'UTC';

-- body is required going forward.
alter table public.notifications alter column body set not null;

create index if not exists notifications_user_unread_idx
  on public.notifications (user_id, created_at desc)
  where read_at is null;

create index if not exists notifications_user_idx
  on public.notifications (user_id, created_at desc);
