-- Client <-> 8338 Team messaging (user 2026-11-22): each client company gets
-- one shared conversation with every active Operations Manager and Company
-- Administrator, as a shared team inbox (Intercom / Zendesk / Front): anyone
-- on the team can answer and the client sees who did.
--
-- Built on group chats: a group with client_id set is that client's team
-- thread. Membership is kept in step by the backend (client + current Ops
-- Managers + Company Administrators); nobody renames it or adds/removes people.
--
-- after_hours_notice_at: when the last "our team is back at 8 AM" line was
-- posted, so it shows at most once per closed period.

ALTER TABLE public.group_conversations
  ADD COLUMN IF NOT EXISTS client_id uuid,
  ADD COLUMN IF NOT EXISTS after_hours_notice_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'group_conversations_client_id_fkey') THEN
    ALTER TABLE public.group_conversations
      ADD CONSTRAINT group_conversations_client_id_fkey
      FOREIGN KEY (client_id) REFERENCES public.clients(client_id) ON DELETE CASCADE;
  END IF;
END $$;

-- One team thread per client company.
CREATE UNIQUE INDEX IF NOT EXISTS group_conversations_client_team_uniq
  ON public.group_conversations (client_id) WHERE client_id IS NOT NULL;
