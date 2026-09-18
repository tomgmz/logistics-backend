-- Self-service password reset for the IT Admin, by emailed OTP.
--
-- Every other role's reset is mediated: the user raises a request, an admin sees
-- it in a queue and sends the one-time link. That works because someone else is
-- always there to act -- except for the IT Admin, whose own queue is staffed by
-- the IT Admin. A locked-out IT Admin was waiting on themselves, which is no way
-- out at all.
--
-- So the IT Admin, and only the IT Admin, proves control of the registered
-- mailbox with a 6-digit code instead of waiting for an approver. The code is not
-- the credential that resets the password: verifying it mints the same opaque
-- token the link flow uses, and the existing /auth/reset-password endpoint
-- finishes the job unchanged. That keeps one completion path -- one place that
-- clears the lockout, burns the token and cuts every live session.

alter table public.password_reset_requests
  -- 'link' is every mediated request (the default keeps existing rows correct);
  -- 'otp' is the IT Admin's self-service path. The admin queue lists 'link' only,
  -- so an OTP request is never sitting in a queue with a Send button next to it.
  add column if not exists delivery_method text not null default 'link'
    check (delivery_method in ('link', 'otp')),
  -- bcrypt of the 6-digit code, the same way otp_codes stores a sign-in OTP. A
  -- 6-digit secret is guessable in a way a 256-bit token is not, which is why it
  -- carries its own attempt counter and a much shorter life than a reset link.
  add column if not exists otp_hash       text,
  add column if not exists otp_expires_at timestamptz,
  add column if not exists otp_attempts   integer not null default 0,
  -- Drives the resend cooldown, and outlives the code being spent or expired --
  -- the point is that an email went out recently, not that it is still usable.
  add column if not exists otp_sent_at    timestamptz;

-- The open-request lookup on the OTP path filters by delivery_method, which the
-- queue index (handler_group, status, created_at) cannot serve.
create index if not exists password_reset_open_otp_idx
  on public.password_reset_requests (user_id)
  where delivery_method = 'otp' and status = 'pending';
