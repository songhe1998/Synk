begin;

alter table public.website_jobs
  add column if not exists generation_profile text,
  add column if not exists provider_metadata jsonb;

update public.website_jobs
set generation_profile = 'econ'
where generation_profile is null;

alter table public.website_jobs
  alter column generation_profile set default 'fast',
  alter column generation_profile set not null;

alter table public.website_jobs
  drop constraint if exists website_jobs_generation_profile_check;

alter table public.website_jobs
  add constraint website_jobs_generation_profile_check
  check (generation_profile in ('fast', 'econ'));

alter table public.website_jobs
  drop constraint if exists website_jobs_framework_check;

alter table public.website_jobs
  add constraint website_jobs_framework_check
  check (framework in ('vite-react', 'next-react'));

commit;
