begin;

alter table public.website_jobs
  add column if not exists parent_job_id uuid references public.website_jobs (id) on delete set null,
  add column if not exists revision_number integer,
  add column if not exists job_kind text,
  add column if not exists edit_instruction_text text,
  add column if not exists edit_target jsonb;

update public.website_jobs
set revision_number = 1
where revision_number is null;

update public.website_jobs
set job_kind = 'initial'
where job_kind is null;

alter table public.website_jobs
  alter column revision_number set default 1,
  alter column revision_number set not null,
  alter column job_kind set default 'initial',
  alter column job_kind set not null;

alter table public.website_jobs
  drop constraint if exists website_jobs_job_kind_check;

alter table public.website_jobs
  add constraint website_jobs_job_kind_check
  check (job_kind in ('initial', 'edit'));

create index if not exists website_jobs_parent_job_id_idx
  on public.website_jobs (parent_job_id, created_at desc);

commit;
