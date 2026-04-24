begin;

alter table public.sessions
  add column if not exists image_follow_mode text;

alter table public.sessions
  alter column image_follow_mode set default 'auto';

update public.sessions
set image_follow_mode = 'auto'
where image_follow_mode is null;

alter table public.sessions
  alter column image_follow_mode set not null;

alter table public.sessions
  drop constraint if exists sessions_image_follow_mode_check;

alter table public.sessions
  add constraint sessions_image_follow_mode_check
  check (image_follow_mode in ('auto', 'loose', 'close'));

update public.sessions
set image_generation_profile = 'pro'
where image_generation_profile is null
   or image_generation_profile not in ('pro', 'fast');

alter table public.sessions
  alter column image_generation_profile set default 'fast',
  alter column image_generation_profile set not null;

alter table public.sessions
  drop constraint if exists sessions_image_generation_profile_check;

alter table public.sessions
  add constraint sessions_image_generation_profile_check
  check (image_generation_profile in ('pro', 'fast'));

commit;
