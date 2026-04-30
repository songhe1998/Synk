alter table public.session_payloads
  add column if not exists canvas_image_layers jsonb not null default '[]'::jsonb;
