-- Driver app releases (2026-10-24).
--
-- The app is not on the Play Store, so drivers download the APK from the
-- website's /download page. The file lives in Cloudflare R2 (too big for
-- Cloudinary's 10 MB raw limit or Supabase's 50 MB free limit); this table is
-- the list of uploads. The newest row is what /download offers.

create table if not exists public.app_releases (
  release_id   uuid primary key default gen_random_uuid(),
  version      text not null,
  notes        text,
  -- The object's key in the R2 bucket and its public URL.
  file_key     text not null unique,
  file_url     text not null,
  size_bytes   bigint not null check (size_bytes > 0),
  uploaded_by  uuid references public.users(user_id) on delete set null,
  created_at   timestamptz not null default now()
);

create index if not exists app_releases_created_at_idx
  on public.app_releases (created_at desc);

-- Read and written only by the backend (service role).
alter table public.app_releases enable row level security;
