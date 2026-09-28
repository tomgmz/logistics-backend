-- Drop clients.billing_mode, the last piece of reverse billing.
--
-- Split out of 20260924000000_remove_billing_and_accountant.sql because getMe
-- (findUserWithClient) still selected the column when that migration was
-- applied. Run this ONLY after the backend without that select is deployed —
-- otherwise every client session fails to load. create_user_with_profile
-- already stopped inserting it (20260924000000), and the column's 'monthly'
-- default covered the gap in between.

begin;

alter table public.clients drop column if exists billing_mode;

commit;
