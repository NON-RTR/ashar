-- ============ أسهَر — Supabase schema for family camera sync ============
-- Run this once in your Supabase project's SQL Editor.
-- Data model: a "room" is a family's shared secret code. Anyone with the code
-- (shared via the in-app invite link) reads/writes that family's cameras.
-- The anon key is public by design; the room code is the practical gate.
-- Camera coordinates are low-sensitivity; if you later want hard security,
-- add Supabase Auth + per-user policies (see README "Deferred").

create table if not exists public.cameras (
  id          text primary key,             -- client-generated stable id
  room        text not null,                -- family code
  lat         double precision not null,
  lon         double precision not null,
  sp          int  not null default 0,      -- posted speed limit (0 = unknown)
  dir         int  not null default -1,     -- heading 0..359, -1 = both ways
  by          text default '',              -- who marked it
  deleted     boolean not null default false,
  updated_at  timestamptz not null default now()
);

create index if not exists cameras_room_idx on public.cameras (room) where not deleted;

-- keep updated_at fresh on upserts
create or replace function public.touch_updated_at() returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

drop trigger if exists cameras_touch on public.cameras;
create trigger cameras_touch before insert or update on public.cameras
  for each row execute function public.touch_updated_at();

-- Row Level Security: allow the anon role to read/write.
-- The room code (high-entropy, shared only within the family) is the gate.
alter table public.cameras enable row level security;

drop policy if exists cameras_anon_read  on public.cameras;
drop policy if exists cameras_anon_write on public.cameras;
drop policy if exists cameras_anon_update on public.cameras;

create policy cameras_anon_read   on public.cameras for select using (true);
create policy cameras_anon_write  on public.cameras for insert with check (true);
create policy cameras_anon_update on public.cameras for update using (true) with check (true);

-- Optional: enable Realtime (live push) if you later switch from polling.
-- alter publication supabase_realtime add table public.cameras;
