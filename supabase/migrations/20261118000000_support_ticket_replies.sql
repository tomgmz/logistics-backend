-- Email replies on support tickets (2026-11-18, the Zendesk pattern).
--
-- Ticket emails now set Reply-To to an address Resend receives for us
-- (TICKET_REPLY_EMAIL). Every reply there reaches POST /api/webhooks/resend-inbound
-- and is stored here against the ticket named in the subject ([TCK-000123]):
--   client — from the client's account email: the ticket shows "Client replied",
--            and a client reply on a resolved ticket reopens it;
--   staff  — from the support inbox (Reply all in Gmail): "Waiting for client";
--   other  — any other address (a colleague, a personal email): shown with the
--            address, never reopens anything.
-- Staff may still mark a ticket resolved without a client reply; the Tickets
-- page only warns.

ALTER TABLE public.support_tickets
  ADD COLUMN IF NOT EXISTS client_last_reply_at timestamptz,
  ADD COLUMN IF NOT EXISTS staff_last_reply_at  timestamptz,
  ADD COLUMN IF NOT EXISTS reopened_at          timestamptz,
  ADD COLUMN IF NOT EXISTS reopen_count         integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS public.support_ticket_replies (
  reply_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id    uuid NOT NULL REFERENCES public.support_tickets(ticket_id) ON DELETE CASCADE,
  direction    text NOT NULL CHECK (direction IN ('client', 'staff', 'other')),
  from_email   text NOT NULL,
  from_name    text,
  -- The new part of the reply (quoted history cut off), at most 4000 characters.
  body_text    text NOT NULL DEFAULT '' CHECK (char_length(body_text) <= 4000),
  -- Resend's id for the received email: a retried webhook is stored once.
  email_id     text NOT NULL UNIQUE,
  received_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_support_ticket_replies_ticket
  ON public.support_ticket_replies (ticket_id, received_at);

-- The API (service role) is the only reader and writer, as with every table.
ALTER TABLE public.support_ticket_replies ENABLE ROW LEVEL SECURITY;

-- Live: a new reply re-reads the Tickets page (same topic as the tickets).
DROP TRIGGER IF EXISTS live_signal ON public.support_ticket_replies;
CREATE TRIGGER live_signal AFTER INSERT OR UPDATE OR DELETE ON public.support_ticket_replies
  FOR EACH ROW EXECUTE FUNCTION public.live_signal_trigger('ticket_id', 'live:support_tickets');
