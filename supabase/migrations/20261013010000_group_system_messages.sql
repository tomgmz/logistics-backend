-- Group chat events ("Tom named the group …", "Tom added Ana") live in the
-- message history as system messages, so everyone sees them in order with the
-- conversation, live and after a reload.
--
-- `content` still holds a plain sentence for list previews; `meta` carries the
-- structured event the chat renders from (so the actor can read "You …").
alter table public.group_messages
  add column if not exists message_type text not null default 'text'
    check (message_type in ('text', 'system')),
  add column if not exists meta jsonb;
