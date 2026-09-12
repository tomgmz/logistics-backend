-- Admin-mediated password resets.
--
-- The lockout ladder already exists (3 wrong attempts -> 3-minute lock, 3 of
-- those cycles -> status 'permanently_locked'), but 'permanently_locked' was a
-- terminal state with no way out. This table is the queue that gives it one:
-- a user asks for a reset, the row lands in the right admin's queue, that admin
-- sends a one-time link, and completing the reset is what lifts the lock.
--
-- Routing is decided once, at request time, and frozen in `handler_group`:
--   driver / client      -> 'company_admin'  (the `admin` role)
--   every staff role     -> 'it_admin'
-- Freezing it means a role change mid-request cannot silently move a row
-- between queues, and the authorization check on send reads the same value the
-- notification was addressed from.

create table if not exists public.password_reset_requests (
  request_id        uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.users(user_id) on delete cascade,
  -- Snapshots of the requester, so a queue row still reads correctly after the
  -- user is edited (or renamed) and stays readable for audit after the fact.
  email             text not null,
  requested_role    text not null,
  handler_group     text not null check (handler_group in ('company_admin', 'it_admin')),
  status            text not null default 'pending'
                      check (status in ('pending', 'sent', 'completed', 'cancelled', 'expired')),
  -- sha256(token + TOKEN_PEPPER), via the same hashToken() used for session
  -- tokens. Null until an admin actually sends the link. The plaintext token
  -- exists only in the email.
  token_hash        text,
  token_expires_at  timestamptz,
  sent_by           uuid references public.users(user_id) on delete set null,
  sent_at           timestamptz,
  completed_at      timestamptz,
  requested_ip      text,
  -- When the admin queue was last told about this request, so a user hammering
  -- "forgot password" cannot spam the notification bell.
  last_notified_at  timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- One open request per user: a second "forgot password" reuses the existing row
-- instead of filling the admin queue with duplicates of the same person.
create unique index if not exists password_reset_one_open_per_user
  on public.password_reset_requests (user_id)
  where status in ('pending', 'sent');

create index if not exists password_reset_queue_idx
  on public.password_reset_requests (handler_group, status, created_at desc);

create index if not exists password_reset_token_idx
  on public.password_reset_requests (token_hash)
  where status = 'sent';

-- Service-role only, same reasoning as 20260828010000_enable_rls_on_service_role_tables:
-- RLS ON with NO policies means service_role and the table owner bypass it and keep
-- working, while the anon key (which ships inside the web and mobile clients) matches
-- no policy and gets nothing. A reset queue is exactly the table you do not want
-- readable with a publishable key.
alter table public.password_reset_requests enable row level security;
