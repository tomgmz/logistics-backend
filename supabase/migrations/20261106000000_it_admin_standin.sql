-- IT Administrator stand-in (user's rule, 2026-11-06).
--
-- If the IT Administrator resigns and no successor has confirmed within the
-- 30-day render, ONE Company Administrator, named on the handover by the
-- outgoing IT Administrator, takes over every IT Administrator power until the
-- new IT Administrator sets their own password. On that day-30 switch the
-- outgoing IT Administrator is archived (the render scheduler does it).
--
-- standin_id is a plain uuid, deliberately WITHOUT a foreign key: this table
-- already has three FKs to users (outgoing, successor, created_by), and every
-- extra users FK is one more way for an unnamed PostgREST embed to turn
-- ambiguous ("more than one relationship was found"; see the 2026-11-01
-- hotfixes). The service checks the stand-in is an active Company Administrator.

alter table public.it_admin_handovers
  add column if not exists standin_id           uuid,
  add column if not exists standin_named_at     timestamptz,
  -- Set by the render scheduler once the render is overdue with no confirmed
  -- successor: from here the stand-in holds the IT Administrator powers.
  add column if not exists standin_activated_at timestamptz;

comment on column public.it_admin_handovers.standin_id is
  'Company Administrator who takes over the IT Administrator powers if no successor has confirmed by render_due_at. No FK on purpose (embed ambiguity).';
comment on column public.it_admin_handovers.standin_activated_at is
  'When the stand-in took over (render overdue, no confirmed successor). The powers end with the handover (ended_at / cancelled_at).';
