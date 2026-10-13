-- Deleting a group message removes it for the person who deleted it only;
-- everyone else in the group still sees it. Each row hides one message from
-- one member. (Direct messages already work this way, through the
-- deleted_by_sender / deleted_by_receiver flags on `messages`.)
create table if not exists public.group_message_hidden (
  message_id uuid not null references public.group_messages(message_id) on delete cascade,
  user_id    uuid not null references public.users(user_id) on delete cascade,
  hidden_at  timestamptz not null default now(),
  primary key (message_id, user_id)
);

create index if not exists group_message_hidden_user on public.group_message_hidden (user_id);

alter table public.group_message_hidden enable row level security;
