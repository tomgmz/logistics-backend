-- In-app voice calls between two people in a direct conversation (LiveKit).
--
-- A call from the Messages screen: the caller presses the phone button, the
-- other participant's browser or phone rings, and either can hang up. Clients
-- are never on either end; the server refuses those before a row is written.
--
-- Separate from emergency_calls on purpose: an emergency call simulrings a desk
-- and falls back to the phone dialer, and its rows are part of the incident
-- record. A chat call is one person ringing one person.

CREATE TABLE IF NOT EXISTS public.chat_calls (
  call_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.conversations(conversation_id) ON DELETE CASCADE,
  caller_id       uuid NOT NULL REFERENCES public.users(user_id) ON DELETE CASCADE,
  callee_id       uuid NOT NULL REFERENCES public.users(user_id) ON DELETE CASCADE,

  -- The LiveKit room. One room per call, never reused.
  room_name text NOT NULL UNIQUE,

  -- ringing  — the callee is being rung
  -- answered — the callee picked up; the call is live
  -- ended    — an answered call finished
  -- missed   — the caller gave up or the ring timed out
  -- declined — the callee pressed Decline
  status varchar(10) NOT NULL DEFAULT 'ringing'
    CHECK (status IN ('ringing', 'answered', 'ended', 'missed', 'declined')),

  answered_at timestamptz,
  ended_by    uuid REFERENCES public.users(user_id) ON DELETE SET NULL,
  ended_at    timestamptz,
  -- hangup | no_answer | declined | failed | timeout
  end_reason  varchar(20),

  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chat_calls_open_callee
  ON public.chat_calls (callee_id, created_at DESC) WHERE status IN ('ringing', 'answered');
CREATE INDEX IF NOT EXISTS idx_chat_calls_open_caller
  ON public.chat_calls (caller_id, created_at DESC) WHERE status IN ('ringing', 'answered');
CREATE INDEX IF NOT EXISTS idx_chat_calls_conversation
  ON public.chat_calls (conversation_id, created_at DESC);

-- Same posture as the other operational tables: RLS on, no policy, service-role only.
ALTER TABLE public.chat_calls ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.chat_calls IS
  'In-app voice calls placed from a direct conversation: who called whom, whether it was answered, and how it ended.';
