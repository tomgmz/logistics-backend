-- BLOWBAGETS "Self" comes from the driver (user 2026-11-28).
--
-- The last S of BLOWBAGETS is the driver's own fitness (rested, not sick, no
-- alcohol or drugs, licence on them). The Fleet Manager's vehicle inspection
-- can't answer it for whoever drives that day, so the web locks it and the
-- driver answers it at Start Navigation:
--
--   fit      -> driver_self_check_at / _by / _name, the delivery starts
--   not fit  -> driver_unfit_at / _name, the start is refused and the office
--               is told to arrange another driver
--
-- _by is drivers.driver_id WITHOUT a foreign key on purpose: bookings is
-- embedded with drivers elsewhere, and a second FK between them would make
-- those PostgREST embeds ambiguous (CLAUDE.md). The name is a snapshot, so the
-- record still reads right after the driver is archived.

alter table public.bookings
  add column if not exists driver_self_check_at   timestamptz,
  add column if not exists driver_self_check_by   uuid,
  add column if not exists driver_self_check_name text,
  add column if not exists driver_unfit_at        timestamptz,
  add column if not exists driver_unfit_name      text;
