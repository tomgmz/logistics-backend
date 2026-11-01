-- Hotfix (2026-11-01): 20261101020000 gave drivers a SECOND foreign key to
-- users (license_verified_by). PostgREST then refuses every unnamed
-- drivers <-> users embed ("more than one relationship was found for 'users'
-- and 'drivers'"), which broke driver creation and every read that embeds a
-- driver's name. The column stays (who ticked the LTMS check); only the
-- constraint goes, so drivers keeps exactly one relationship to users.
-- Never add another FK from drivers to users.

ALTER TABLE public.drivers DROP CONSTRAINT IF EXISTS drivers_license_verified_by_fkey;
