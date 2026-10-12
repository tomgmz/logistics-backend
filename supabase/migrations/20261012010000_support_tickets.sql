-- Client support tickets.
--
-- The web has an FAQ chatbot for clients. When it can't answer, the client opens
-- a ticket from the chat. The ticket goes to the company inbox by email (with
-- the client as reply-to) and the conversation happens by email from there.
-- This table is the record: what was asked, about which booking, the chat that
-- led to it, and when staff marked it resolved.
--
-- Clients only open tickets; the Company Administrator and the Operations
-- Manager see the queue on their dashboard and mark tickets resolved.

CREATE TABLE IF NOT EXISTS public.support_tickets (
  ticket_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Human reference, shown as TCK-000123.
  ticket_number  bigserial UNIQUE,
  client_id      uuid NOT NULL REFERENCES public.clients(client_id) ON DELETE CASCADE,
  -- Who opened it (the client's user account).
  opened_by      uuid REFERENCES public.users(user_id) ON DELETE SET NULL,
  booking_id     uuid REFERENCES public.bookings(booking_id) ON DELETE SET NULL,

  category       text NOT NULL
    CHECK (category IN ('booking', 'delivery', 'tracking', 'documents', 'account', 'other')),
  subject        text NOT NULL CHECK (char_length(subject) BETWEEN 3 AND 150),
  message        text NOT NULL CHECK (char_length(message) BETWEEN 10 AND 4000),
  -- The chatbot exchange that led to the ticket, so staff see what was tried.
  chat_transcript jsonb NOT NULL DEFAULT '[]'::jsonb,

  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  resolved_at    timestamptz,
  resolved_by    uuid REFERENCES public.users(user_id) ON DELETE SET NULL,
  resolution_note text CHECK (resolution_note IS NULL OR char_length(resolution_note) <= 2000),

  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_support_tickets_status_created
  ON public.support_tickets (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_tickets_client
  ON public.support_tickets (client_id, created_at DESC);

-- The API (service role) is the only reader and writer, as with every table.
ALTER TABLE public.support_tickets ENABLE ROW LEVEL SECURITY;

-- Live: the dashboards' ticket queue and the client's "My tickets" re-read on
-- change. Id-only, same as every other live:* topic.
DROP TRIGGER IF EXISTS live_signal ON public.support_tickets;
CREATE TRIGGER live_signal AFTER INSERT OR UPDATE OR DELETE ON public.support_tickets
  FOR EACH ROW EXECUTE FUNCTION public.live_signal_trigger('ticket_id', 'live:support_tickets');
