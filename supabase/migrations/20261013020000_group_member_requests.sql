-- Only a group's creator changes its membership directly. Any other member
-- asks: a request to add or remove someone waits here until the creator
-- approves or declines it.
create table if not exists public.group_member_requests (
  request_id     uuid primary key default gen_random_uuid(),
  group_id       uuid not null references public.group_conversations(group_id) on delete cascade,
  requested_by   uuid not null references public.users(user_id) on delete cascade,
  target_user_id uuid not null references public.users(user_id) on delete cascade,
  action         text not null check (action in ('add', 'remove')),
  status         text not null default 'pending' check (status in ('pending', 'approved', 'declined')),
  decided_by     uuid references public.users(user_id) on delete set null,
  decided_at     timestamptz,
  created_at     timestamptz not null default now()
);

-- One open request per person and action at a time.
create unique index if not exists group_member_requests_one_pending
  on public.group_member_requests (group_id, target_user_id, action)
  where status = 'pending';

create index if not exists group_member_requests_group_status
  on public.group_member_requests (group_id, status);

alter table public.group_member_requests enable row level security;
