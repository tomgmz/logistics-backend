-- Client support conversations: AI + our team + email in one thread
-- (user 2026-11-22, the Intercom / Zendesk model).
--
-- A client asks the help assistant; that exchange is one conversation. "Talk
-- to our team" hands the same conversation to the Operations Managers and
-- Company Administrators (staff inbox = Conversations tab on Tickets). A staff
-- reply the client hasn't read in 15 minutes is emailed; replying to that
-- email (subject [CHT-000123]) adds to the conversation. Resolved by staff, or
-- by itself 3 days after a staff reply the client never answered; a client
-- message within 7 days of resolving reopens it.
--
-- Replaces the one-chat-per-client "8338 Team" group from 20261122010000: its
-- messages are copied into one conversation per client below and the groups
-- are removed (group_conversations.client_id stays, unused).

CREATE TABLE IF NOT EXISTS public.support_conversations (
  conversation_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_number    bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  client_id              uuid NOT NULL,
  client_user_id         uuid NOT NULL,
  title                  text NOT NULL DEFAULT '',
  status                 text NOT NULL DEFAULT 'assistant'
                           CHECK (status IN ('assistant', 'waiting', 'replied', 'resolved')),
  handed_over_at         timestamptz,
  last_message_at        timestamptz NOT NULL DEFAULT now(),
  last_client_message_at timestamptz,
  last_staff_message_at  timestamptz,
  last_staff_replier_id  uuid,
  -- Who owns it (Zendesk / Intercom assignment): the first staff member to
  -- reply; another takes over with "Take over". Alerts go to them.
  assigned_to            uuid,
  assigned_at            timestamptz,
  resolved_at            timestamptz,
  resolved_by            uuid,
  resolved_reason        text CHECK (resolved_reason IN ('staff', 'auto')),
  ticket_id              uuid,
  after_hours_notice_at  timestamptz,
  -- When the last missed-reply email went out (one per unread staff burst).
  emailed_at             timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT support_conversations_client_id_fkey      FOREIGN KEY (client_id)      REFERENCES public.clients(client_id) ON DELETE CASCADE,
  CONSTRAINT support_conversations_client_user_id_fkey FOREIGN KEY (client_user_id) REFERENCES public.users(user_id),
  CONSTRAINT support_conversations_last_staff_replier_id_fkey FOREIGN KEY (last_staff_replier_id) REFERENCES public.users(user_id),
  CONSTRAINT support_conversations_resolved_by_fkey    FOREIGN KEY (resolved_by)    REFERENCES public.users(user_id),
  CONSTRAINT support_conversations_assigned_to_fkey    FOREIGN KEY (assigned_to)    REFERENCES public.users(user_id),
  CONSTRAINT support_conversations_ticket_id_fkey      FOREIGN KEY (ticket_id)      REFERENCES public.support_tickets(ticket_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS support_conversations_client_idx ON public.support_conversations (client_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS support_conversations_status_idx ON public.support_conversations (status, last_message_at DESC);
CREATE INDEX IF NOT EXISTS support_conversations_assigned_idx ON public.support_conversations (assigned_to) WHERE assigned_to IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.support_messages (
  message_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id    uuid NOT NULL,
  -- client / assistant (the help assistant's answer) / staff / system (handover, after-hours, resolved…)
  author             text NOT NULL CHECK (author IN ('client', 'assistant', 'staff', 'system')),
  author_id          uuid,
  content            text NOT NULL DEFAULT '',
  attachment_url     text,
  attachment_stamped boolean NOT NULL DEFAULT false,
  -- 'chat' or 'email' (a reply that came in by email)
  via                text NOT NULL DEFAULT 'chat' CHECK (via IN ('chat', 'email')),
  -- assistant: { ai, faq_id, source_ids }; system: { event }
  meta               jsonb,
  -- The Resend id of an emailed reply (a retried webhook is stored once).
  email_id           text UNIQUE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT support_messages_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.support_conversations(conversation_id) ON DELETE CASCADE,
  CONSTRAINT support_messages_author_id_fkey       FOREIGN KEY (author_id)       REFERENCES public.users(user_id)
);

CREATE INDEX IF NOT EXISTS support_messages_conversation_idx ON public.support_messages (conversation_id, created_at);

CREATE TABLE IF NOT EXISTS public.support_conversation_reads (
  conversation_id uuid NOT NULL,
  user_id         uuid NOT NULL,
  last_read_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, user_id),
  CONSTRAINT support_conversation_reads_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.support_conversations(conversation_id) ON DELETE CASCADE,
  CONSTRAINT support_conversation_reads_user_id_fkey         FOREIGN KEY (user_id)         REFERENCES public.users(user_id) ON DELETE CASCADE
);

-- Server only (service role), like support_tickets.
ALTER TABLE public.support_conversations      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_messages           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_conversation_reads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.support_conversations, public.support_messages, public.support_conversation_reads FROM anon, authenticated;

-- Live table: the staff inbox and the client's list refresh on any change.
DROP TRIGGER IF EXISTS live_signal ON public.support_conversations;
CREATE TRIGGER live_signal AFTER INSERT OR UPDATE OR DELETE ON public.support_conversations
  FOR EACH ROW EXECUTE FUNCTION public.live_signal_trigger('conversation_id', 'live:support_conversations');

-- Move the "8338 Team" group chats (one per client) into conversations.
DO $$
DECLARE
  g record;
  conv uuid;
  last_author text;
BEGIN
  FOR g IN
    SELECT gc.group_id, gc.client_id, c.user_id AS client_user_id, gc.created_at
    FROM public.group_conversations gc
    JOIN public.clients c ON c.client_id = gc.client_id
    WHERE gc.client_id IS NOT NULL
  LOOP
    IF EXISTS (SELECT 1 FROM public.group_messages m WHERE m.group_id = g.group_id AND m.deleted_at IS NULL) THEN
      INSERT INTO public.support_conversations (client_id, client_user_id, title, status, handed_over_at, created_at)
      VALUES (g.client_id, g.client_user_id, 'Messages with our team', 'waiting', g.created_at, g.created_at)
      RETURNING conversation_id INTO conv;

      INSERT INTO public.support_messages (conversation_id, author, author_id, content, attachment_url, attachment_stamped, meta, created_at)
      SELECT conv,
             CASE WHEN m.message_type = 'system' THEN 'system'
                  WHEN m.sender_id = g.client_user_id THEN 'client'
                  ELSE 'staff' END,
             CASE WHEN m.message_type = 'system' THEN NULL ELSE m.sender_id END,
             m.content, m.attachment_url, COALESCE(m.attachment_stamped, false),
             CASE WHEN m.message_type = 'system' THEN jsonb_build_object('event', 'after_hours') ELSE NULL END,
             m.sent_at
      FROM public.group_messages m
      WHERE m.group_id = g.group_id AND m.deleted_at IS NULL
      ORDER BY m.sent_at;

      SELECT author INTO last_author FROM public.support_messages
      WHERE conversation_id = conv AND author IN ('client', 'staff') ORDER BY created_at DESC LIMIT 1;

      UPDATE public.support_conversations s SET
        status = CASE WHEN last_author = 'staff' THEN 'replied' ELSE 'waiting' END,
        last_message_at        = COALESCE((SELECT max(created_at) FROM public.support_messages WHERE conversation_id = conv), s.created_at),
        last_client_message_at = (SELECT max(created_at) FROM public.support_messages WHERE conversation_id = conv AND author = 'client'),
        last_staff_message_at  = (SELECT max(created_at) FROM public.support_messages WHERE conversation_id = conv AND author = 'staff'),
        last_staff_replier_id  = (SELECT author_id FROM public.support_messages WHERE conversation_id = conv AND author = 'staff' ORDER BY created_at DESC LIMIT 1),
        assigned_to            = (SELECT author_id FROM public.support_messages WHERE conversation_id = conv AND author = 'staff' ORDER BY created_at ASC LIMIT 1),
        assigned_at            = (SELECT min(created_at) FROM public.support_messages WHERE conversation_id = conv AND author = 'staff')
      WHERE s.conversation_id = conv;
    END IF;

    DELETE FROM public.group_conversations WHERE group_id = g.group_id;
  END LOOP;
END $$;
