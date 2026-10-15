-- Photos in chat. A photo message is a normal row with message_type 'image'
-- (already allowed by the type check) and the Cloudinary URL here; `content`
-- holds the caption, or a "📷 Photo" placeholder when there is none, so list
-- previews, push bodies and reply snippets keep working unchanged.
--
-- `attachment_stamped` records whether the time-and-place stamp was burned in,
-- so a viewer can tell an evidence photo from a plain one.
alter table public.messages
  add column if not exists attachment_url     text,
  add column if not exists attachment_stamped boolean not null default false;

alter table public.group_messages
  add column if not exists attachment_url     text,
  add column if not exists attachment_stamped boolean not null default false;
