-- Repair Supabase Auth phones stored with a doubled country code (2026-10-24).
--
-- The staff and driver create services did '+63' + phone.slice(1) on a phone
-- that was already +639XXXXXXXXX, so auth.users.phone became 6363 9XXXXXXXXX
-- while public.users.phone stayed correct. Auth keeps phones as digits without
-- the '+', so the right value is public.users.phone minus its '+'.
--
-- Only rows that are visibly doubled (6363 + 10 digits) and whose profile has a
-- valid number are touched.

update auth.users a
   set phone      = ltrim(u.phone, '+'),
       updated_at = now()
  from public.users u
 where u.user_id = a.id
   and a.phone ~ '^6363[0-9]{10}$'
   and u.phone ~ '^[+]639[0-9]{9}$';
