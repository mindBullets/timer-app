-- UX Capstone Timer: Supabase schema (Phase 3)
-- Run in the Supabase SQL editor. Then create Jumar's auth user,
-- replace YOUR-USER-UUID below with that user's id, and disable public signups.

create table if not exists public.timer_state (
  id int primary key default 1 check (id = 1),
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.presets (
  session_idx int primary key,
  blocks jsonb not null,
  updated_at timestamptz not null default now()
);

insert into public.timer_state (id, state) values (1, '{}'::jsonb)
on conflict (id) do nothing;

alter table public.timer_state enable row level security;
alter table public.presets enable row level security;

-- Everyone (students, anonymous) can read
create policy "public read timer_state" on public.timer_state
  for select using (true);
create policy "public read presets" on public.presets
  for select using (true);

-- Only the teacher account can write
create policy "teacher write timer_state" on public.timer_state
  for all
  using (auth.uid() = 'YOUR-USER-UUID')
  with check (auth.uid() = 'YOUR-USER-UUID');
create policy "teacher write presets" on public.presets
  for all
  using (auth.uid() = 'YOUR-USER-UUID')
  with check (auth.uid() = 'YOUR-USER-UUID');

-- Realtime: students subscribe to state changes
alter publication supabase_realtime add table public.timer_state;
alter publication supabase_realtime add table public.presets;

-- Keep updated_at honest
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

create trigger timer_state_touch before update on public.timer_state
  for each row execute function public.touch_updated_at();
create trigger presets_touch before update on public.presets
  for each row execute function public.touch_updated_at();
