create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  display_name text,
  avatar_url text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.sessions (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null,
  status text not null check (status in ('created', 'uploaded', 'processing', 'ready', 'failed')),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  duration_ms integer not null default 0,
  audio_mime_type text,
  canvas_width integer not null default 0,
  canvas_height integer not null default 0,
  transcript_approximate boolean not null default false,
  analysis_reasoning_effort text not null default 'medium' check (analysis_reasoning_effort in ('low', 'medium', 'high')),
  image_size_preset text not null default 'medium' check (image_size_preset in ('small', 'medium', 'large')),
  image_generation_profile text not null default 'fast' check (image_generation_profile in ('pro', 'fast')),
  image_follow_mode text not null default 'auto' check (image_follow_mode in ('auto', 'loose', 'close')),
  error_message text
);

create table if not exists public.session_payloads (
  session_id uuid primary key references public.sessions (id) on delete cascade,
  events jsonb not null default '[]'::jsonb,
  transcript jsonb not null default '[]'::jsonb,
  analysis jsonb,
  video_source_plan jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.session_assets (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions (id) on delete cascade,
  kind text not null,
  storage_path text not null,
  file_name text not null,
  mime_type text,
  bytes bigint,
  created_at timestamptz not null default timezone('utc', now()),
  unique (session_id, kind)
);

create table if not exists public.video_jobs (
  id uuid primary key,
  session_id uuid not null references public.sessions (id) on delete cascade,
  status text not null check (status in ('queued', 'uploading', 'running', 'succeeded', 'failed')),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  completed_at timestamptz,
  display_name text not null,
  model_preset text not null check (model_preset in ('lite', 'quality')),
  pipeline_mode text not null default 'normal' check (pipeline_mode in ('normal', 'dynamic')),
  requested_model text not null,
  source_asset_kind text not null check (source_asset_kind in ('generatedImageLabeled', 'generatedImagePlain', 'generatedVideoSourceImage')),
  transcript_text text,
  source_image_prompt text,
  source_image_prompt_model text,
  prompt text not null,
  prompt_model text,
  duration_seconds integer not null default 5,
  resolution text check (resolution in ('480p', '720p', '1080p')),
  aspect_ratio text check (aspect_ratio in ('21:9', '16:9', '4:3', '1:1', '3:4', '9:16')),
  camera_fixed boolean,
  request_id text,
  remote_source_url text,
  remote_video_url text,
  video_file_name text,
  video_mime_type text,
  video_storage_path text,
  error_message text,
  status_detail text
);

create table if not exists public.world_jobs (
  id uuid primary key,
  session_id uuid not null references public.sessions (id) on delete cascade,
  status text not null check (status in ('queued', 'running', 'succeeded', 'failed')),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  completed_at timestamptz,
  display_name text not null,
  model_preset text not null check (model_preset in ('draft', 'hd')),
  requested_model text not null,
  source_asset_kind text not null check (source_asset_kind in ('generatedImageLabeled', 'generatedImagePlain')),
  prompt text not null,
  operation_id text,
  operation_expires_at timestamptz,
  world_id text,
  error_message text,
  status_detail text,
  world jsonb
);

create table if not exists public.website_jobs (
  id uuid primary key,
  session_id uuid not null references public.sessions (id) on delete cascade,
  parent_job_id uuid references public.website_jobs (id) on delete set null,
  revision_number integer not null default 1,
  job_kind text not null default 'initial' check (job_kind in ('initial', 'edit')),
  status text not null check (status in ('queued', 'running', 'building', 'exporting', 'succeeded', 'failed')),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  completed_at timestamptz,
  display_name text not null,
  framework text not null check (framework in ('vite-react')),
  sandbox_provider text not null check (sandbox_provider in ('vercel')),
  sandbox_id text,
  transcript_text text not null,
  pages jsonb not null default '[]'::jsonb,
  prompt text not null,
  edit_instruction_text text,
  edit_target jsonb,
  status_detail text,
  error_message text,
  preview_image_file_name text,
  preview_image_mime_type text,
  preview_image_storage_path text,
  code_archive_file_name text,
  code_archive_mime_type text,
  code_archive_storage_path text,
  dist_archive_file_name text,
  dist_archive_mime_type text,
  dist_archive_storage_path text
);

create index if not exists sessions_user_id_idx on public.sessions (user_id, created_at desc);
create index if not exists session_assets_session_id_idx on public.session_assets (session_id);
create index if not exists video_jobs_session_id_idx on public.video_jobs (session_id, created_at desc);
create index if not exists world_jobs_session_id_idx on public.world_jobs (session_id, created_at desc);
create index if not exists website_jobs_session_id_idx on public.website_jobs (session_id, created_at desc);
create index if not exists website_jobs_parent_job_id_idx on public.website_jobs (parent_job_id, created_at desc);

alter table public.profiles enable row level security;
alter table public.sessions enable row level security;
alter table public.session_payloads enable row level security;
alter table public.session_assets enable row level security;
alter table public.video_jobs enable row level security;
alter table public.world_jobs enable row level security;
alter table public.website_jobs enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own"
on public.profiles
for select
to authenticated
using ((select auth.uid()) = id);

drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own"
on public.profiles
for insert
to authenticated
with check ((select auth.uid()) = id);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
on public.profiles
for update
to authenticated
using ((select auth.uid()) = id)
with check ((select auth.uid()) = id);

drop policy if exists "sessions_select_own" on public.sessions;
create policy "sessions_select_own"
on public.sessions
for select
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "sessions_insert_own" on public.sessions;
create policy "sessions_insert_own"
on public.sessions
for insert
to authenticated
with check ((select auth.uid()) = user_id);

drop policy if exists "sessions_update_own" on public.sessions;
create policy "sessions_update_own"
on public.sessions
for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists "sessions_delete_own" on public.sessions;
create policy "sessions_delete_own"
on public.sessions
for delete
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "session_payloads_select_own" on public.session_payloads;
create policy "session_payloads_select_own"
on public.session_payloads
for select
to authenticated
using (
  exists (
    select 1
    from public.sessions
    where sessions.id = session_payloads.session_id
      and sessions.user_id = (select auth.uid())
  )
);

drop policy if exists "session_payloads_insert_own" on public.session_payloads;
create policy "session_payloads_insert_own"
on public.session_payloads
for insert
to authenticated
with check (
  exists (
    select 1
    from public.sessions
    where sessions.id = session_payloads.session_id
      and sessions.user_id = (select auth.uid())
  )
);

drop policy if exists "session_payloads_update_own" on public.session_payloads;
create policy "session_payloads_update_own"
on public.session_payloads
for update
to authenticated
using (
  exists (
    select 1
    from public.sessions
    where sessions.id = session_payloads.session_id
      and sessions.user_id = (select auth.uid())
  )
)
with check (
  exists (
    select 1
    from public.sessions
    where sessions.id = session_payloads.session_id
      and sessions.user_id = (select auth.uid())
  )
);

drop policy if exists "session_payloads_delete_own" on public.session_payloads;
create policy "session_payloads_delete_own"
on public.session_payloads
for delete
to authenticated
using (
  exists (
    select 1
    from public.sessions
    where sessions.id = session_payloads.session_id
      and sessions.user_id = (select auth.uid())
  )
);

drop policy if exists "session_assets_select_own" on public.session_assets;
create policy "session_assets_select_own"
on public.session_assets
for select
to authenticated
using (
  exists (
    select 1
    from public.sessions
    where sessions.id = session_assets.session_id
      and sessions.user_id = (select auth.uid())
  )
);

drop policy if exists "session_assets_insert_own" on public.session_assets;
create policy "session_assets_insert_own"
on public.session_assets
for insert
to authenticated
with check (
  exists (
    select 1
    from public.sessions
    where sessions.id = session_assets.session_id
      and sessions.user_id = (select auth.uid())
  )
);

drop policy if exists "session_assets_update_own" on public.session_assets;
create policy "session_assets_update_own"
on public.session_assets
for update
to authenticated
using (
  exists (
    select 1
    from public.sessions
    where sessions.id = session_assets.session_id
      and sessions.user_id = (select auth.uid())
  )
)
with check (
  exists (
    select 1
    from public.sessions
    where sessions.id = session_assets.session_id
      and sessions.user_id = (select auth.uid())
  )
);

drop policy if exists "session_assets_delete_own" on public.session_assets;
create policy "session_assets_delete_own"
on public.session_assets
for delete
to authenticated
using (
  exists (
    select 1
    from public.sessions
    where sessions.id = session_assets.session_id
      and sessions.user_id = (select auth.uid())
  )
);

drop policy if exists "video_jobs_select_own" on public.video_jobs;
create policy "video_jobs_select_own"
on public.video_jobs
for select
to authenticated
using (
  exists (
    select 1
    from public.sessions
    where sessions.id = video_jobs.session_id
      and sessions.user_id = (select auth.uid())
  )
);

drop policy if exists "video_jobs_insert_own" on public.video_jobs;
create policy "video_jobs_insert_own"
on public.video_jobs
for insert
to authenticated
with check (
  exists (
    select 1
    from public.sessions
    where sessions.id = video_jobs.session_id
      and sessions.user_id = (select auth.uid())
  )
);

drop policy if exists "video_jobs_update_own" on public.video_jobs;
create policy "video_jobs_update_own"
on public.video_jobs
for update
to authenticated
using (
  exists (
    select 1
    from public.sessions
    where sessions.id = video_jobs.session_id
      and sessions.user_id = (select auth.uid())
  )
)
with check (
  exists (
    select 1
    from public.sessions
    where sessions.id = video_jobs.session_id
      and sessions.user_id = (select auth.uid())
  )
);

drop policy if exists "video_jobs_delete_own" on public.video_jobs;
create policy "video_jobs_delete_own"
on public.video_jobs
for delete
to authenticated
using (
  exists (
    select 1
    from public.sessions
    where sessions.id = video_jobs.session_id
      and sessions.user_id = (select auth.uid())
  )
);

drop policy if exists "world_jobs_select_own" on public.world_jobs;
create policy "world_jobs_select_own"
on public.world_jobs
for select
to authenticated
using (
  exists (
    select 1
    from public.sessions
    where sessions.id = world_jobs.session_id
      and sessions.user_id = (select auth.uid())
  )
);

drop policy if exists "world_jobs_insert_own" on public.world_jobs;
create policy "world_jobs_insert_own"
on public.world_jobs
for insert
to authenticated
with check (
  exists (
    select 1
    from public.sessions
    where sessions.id = world_jobs.session_id
      and sessions.user_id = (select auth.uid())
  )
);

drop policy if exists "world_jobs_update_own" on public.world_jobs;
create policy "world_jobs_update_own"
on public.world_jobs
for update
to authenticated
using (
  exists (
    select 1
    from public.sessions
    where sessions.id = world_jobs.session_id
      and sessions.user_id = (select auth.uid())
  )
)
with check (
  exists (
    select 1
    from public.sessions
    where sessions.id = world_jobs.session_id
      and sessions.user_id = (select auth.uid())
  )
);

drop policy if exists "world_jobs_delete_own" on public.world_jobs;
create policy "world_jobs_delete_own"
on public.world_jobs
for delete
to authenticated
using (
  exists (
    select 1
    from public.sessions
    where sessions.id = world_jobs.session_id
      and sessions.user_id = (select auth.uid())
  )
);

drop policy if exists "website_jobs_select_own" on public.website_jobs;
create policy "website_jobs_select_own"
on public.website_jobs
for select
to authenticated
using (
  exists (
    select 1
    from public.sessions
    where sessions.id = website_jobs.session_id
      and sessions.user_id = (select auth.uid())
  )
);

drop policy if exists "website_jobs_insert_own" on public.website_jobs;
create policy "website_jobs_insert_own"
on public.website_jobs
for insert
to authenticated
with check (
  exists (
    select 1
    from public.sessions
    where sessions.id = website_jobs.session_id
      and sessions.user_id = (select auth.uid())
  )
);

drop policy if exists "website_jobs_update_own" on public.website_jobs;
create policy "website_jobs_update_own"
on public.website_jobs
for update
to authenticated
using (
  exists (
    select 1
    from public.sessions
    where sessions.id = website_jobs.session_id
      and sessions.user_id = (select auth.uid())
  )
)
with check (
  exists (
    select 1
    from public.sessions
    where sessions.id = website_jobs.session_id
      and sessions.user_id = (select auth.uid())
  )
);

drop policy if exists "website_jobs_delete_own" on public.website_jobs;
create policy "website_jobs_delete_own"
on public.website_jobs
for delete
to authenticated
using (
  exists (
    select 1
    from public.sessions
    where sessions.id = website_jobs.session_id
      and sessions.user_id = (select auth.uid())
  )
);

insert into storage.buckets (id, name, public)
values ('session-assets', 'session-assets', false)
on conflict (id) do nothing;

drop policy if exists "storage_select_own_session_assets" on storage.objects;
create policy "storage_select_own_session_assets"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'session-assets'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
);

drop policy if exists "storage_insert_own_session_assets" on storage.objects;
create policy "storage_insert_own_session_assets"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'session-assets'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
);

drop policy if exists "storage_update_own_session_assets" on storage.objects;
create policy "storage_update_own_session_assets"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'session-assets'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
)
with check (
  bucket_id = 'session-assets'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
);

drop policy if exists "storage_delete_own_session_assets" on storage.objects;
create policy "storage_delete_own_session_assets"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'session-assets'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
);
