-- Support conversations: closing timers (user 2026-11-22, after Intercom /
-- Zendesk / Freshchat / respond.io / Zoho):
--   * only the assistant answered and the client went quiet → closed after 24 h
--   * the team replied and the client went quiet → reminder (bell + email +
--     line in the chat) after 3 days, closed at 7 days
-- reminded_at = when that reminder went out (one per unanswered staff reply).

ALTER TABLE public.support_conversations
  ADD COLUMN IF NOT EXISTS reminded_at timestamptz;
