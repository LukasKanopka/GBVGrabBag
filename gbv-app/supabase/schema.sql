-- Gator Beach Volleyball - Supabase schema
-- Apply in Supabase SQL Editor or via migrations

-- Required for gen_random_uuid()
create extension if not exists "pgcrypto";

-- =========================
-- tournaments
-- =========================
create table if not exists public.tournaments (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  date date not null,
  access_code text not null unique,
  advancement_rules jsonb,
  game_rules jsonb,
  status text not null default 'draft' check (status in ('draft','setup','pool_play','bracket','completed')),
  created_at timestamptz not null default now()
);

create index if not exists idx_tournaments_date on public.tournaments(date);

-- =========================
-- pools
-- =========================
create table if not exists public.pools (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  name text not null, -- e.g., "Pool A"
  court_assignment text
);

create unique index if not exists pools_tournament_name_uidx on public.pools(tournament_id, name);
create index if not exists pools_tournament_idx on public.pools(tournament_id);

-- =========================
-- teams
-- =========================
create table if not exists public.teams (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  pool_id uuid references public.pools(id) on delete set null,
  seeded_player_name text not null,
  partner_name text,
  full_team_name text not null,
  seed_in_pool integer,
  constraint seed_in_pool_positive check (seed_in_pool is null or seed_in_pool >= 1)
);

create unique index if not exists teams_pool_seed_uidx on public.teams(pool_id, seed_in_pool) where pool_id is not null and seed_in_pool is not null;
create index if not exists teams_tournament_idx on public.teams(tournament_id);
create index if not exists teams_pool_idx on public.teams(pool_id);

-- =========================
-- matches
-- =========================
create table if not exists public.matches (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  pool_id uuid references public.pools(id) on delete set null,
  round_number integer, -- pool round number
  team1_id uuid references public.teams(id) on delete set null,
  team2_id uuid references public.teams(id) on delete set null,
  ref_team_id uuid references public.teams(id) on delete set null,
  team1_score integer,
  team2_score integer,
  winner_id uuid references public.teams(id) on delete set null,
  match_type text not null check (match_type in ('pool','bracket')),
  bracket_round integer, -- for bracket play
  is_live boolean not null default false,
  live_score_team1 integer,
  live_score_team2 integer
);

create index if not exists matches_tournament_idx on public.matches(tournament_id);
create index if not exists matches_pool_idx on public.matches(pool_id);
create index if not exists matches_match_type_idx on public.matches(match_type);

-- =========================
-- schedule_templates
-- =========================
create table if not exists public.schedule_templates (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  pool_size integer not null check (pool_size >= 2),
  template_data jsonb not null -- array of round definitions
);

create unique index if not exists schedule_templates_unique_per_size on public.schedule_templates(tournament_id, pool_size);

-- =========================
-- Recommended RLS setup (soft-open for MVP; tighten later)
-- =========================

-- Enable RLS
alter table public.tournaments enable row level security;
alter table public.pools enable row level security;
alter table public.teams enable row level security;
alter table public.matches enable row level security;
alter table public.schedule_templates enable row level security;

-- Allow read for everyone (public app usage)
create policy if not exists "tournaments_read_all" on public.tournaments for select using (true);
create policy if not exists "pools_read_all" on public.pools for select using (true);
create policy if not exists "teams_read_all" on public.teams for select using (true);
create policy if not exists "matches_read_all" on public.matches for select using (true);
create policy if not exists "schedule_templates_read_all" on public.schedule_templates for select using (true);

-- For MVP: allow inserts/updates on matches to any authenticated user
-- (Players will submit scores; Admin uses same anon key in client. Tighten with auth later.)
create policy if not exists "matches_write_authenticated" on public.matches
for insert
to authenticated
with check (true);

create policy if not exists "matches_update_authenticated" on public.matches
for update
to authenticated
using (true)
with check (true);

-- Admin write access (authenticated). You can later restrict by roles or JWT claims.
create policy if not exists "tournaments_write_authenticated" on public.tournaments
for all
to authenticated
using (true)
with check (true);

create policy if not exists "pools_write_authenticated" on public.pools
for all
to authenticated
using (true)
with check (true);

create policy if not exists "teams_write_authenticated" on public.teams
for all
to authenticated
using (true)
with check (true);

create policy if not exists "schedule_templates_write_authenticated" on public.schedule_templates
for all
to authenticated
using (true)
with check (true);

-- =========================
-- Helpful constraints/triggers (optional)
-- =========================

-- winner_id should be one of team1_id or team2_id when present
create or replace function public.validate_winner_is_participant()
returns trigger
language plpgsql
as $$
begin
  if new.winner_id is not null then
    if new.winner_id <> new.team1_id and new.winner_id <> new.team2_id then
      raise exception 'winner_id must be team1_id or team2_id';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists matches_validate_winner on public.matches;
create trigger matches_validate_winner
before insert or update on public.matches
for each row execute function public.validate_winner_is_participant();

-- live score sanity
create or replace function public.validate_live_scores()
returns trigger
language plpgsql
as $$
begin
  if new.is_live = false then
    -- when match is not live, live scores can be null or set; keep as-is
    return new;
  end if;

  if new.live_score_team1 is null or new.live_score_team2 is null then
    raise exception 'live scores must be present when is_live = true';
  end if;

  if new.live_score_team1 < 0 or new.live_score_team2 < 0 then
    raise exception 'live scores must be non-negative';
  end if;

  return new;
end;
$$;

drop trigger if exists matches_validate_live on public.matches;
create trigger matches_validate_live
before insert or update on public.matches
for each row execute function public.validate_live_scores();