-- A device gets a user's notifications only while the sign-in that registered
-- it is still live.
--
-- Before this, a phone stayed registered to whoever last signed in on it until
-- someone else signed in: a session that expired, was replaced or was revoked
-- left the token behind, so the phone kept receiving that user's alerts (one
-- driver's assignment showing up on another driver's phone). Each subscription
-- now names the session that registered it; sends skip any whose session has
-- ended and delete them, and deleting a session row takes its subscriptions
-- with it.
alter table public.push_subscriptions
  add column if not exists session_id uuid references public.active_sessions(id) on delete cascade;

create index if not exists push_subscriptions_session on public.push_subscriptions (session_id);
