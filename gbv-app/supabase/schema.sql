-- 1) Extensions schema + extension installation (install extensions into a dedicated schema)
create schema if not exists extensions;
create extension if not exists "pgcrypto" with schema extensions;

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
  bracket_started boolean not null default false,
  bracket_generated_at timestamptz,
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
  court_assignment text,
  target_size integer
);

create unique index if not exists pools_tournament_name_uidx on public.pools(tournament_id, name);
create index if not exists pools_tournament_idx on public.pools(tournament_id);

-- Backward-compatible migration for existing databases
alter table public.pools add column if not exists target_size integer;

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
-- Global tournament seed per player (seed_global)
-- =========================
alter table public.teams add column if not exists seed_global integer;

-- Ensure positive seed or null
alter table public.teams drop constraint if exists seed_global_positive;
alter table public.teams add constraint seed_global_positive check (seed_global is null or seed_global >= 1);

-- Unique per tournament when present
create unique index if not exists teams_tournament_seed_global_uidx
  on public.teams(tournament_id, seed_global)
  where seed_global is not null;

-- Helpful index for ordering by global seed
create index if not exists teams_seed_global_idx on public.teams(seed_global);

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

-- Indexes for FK columns on matches to speed joins
create index if not exists idx_matches_team1 on public.matches(team1_id);
create index if not exists idx_matches_team2 on public.matches(team2_id);
create index if not exists idx_matches_ref_team on public.matches(ref_team_id);
create index if not exists idx_matches_winner on public.matches(winner_id);

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

-- Idempotent policy creation pattern: DROP IF EXISTS, then CREATE
-- PUBLIC read access (explicit TO public) — replace TO public with TO authenticated if you want only logged-in users
drop policy if exists "tournaments_read_all" on public.tournaments;
create policy "tournaments_read_all" on public.tournaments for select to public using (true);

drop policy if exists "pools_read_all" on public.pools;
create policy "pools_read_all" on public.pools for select to public using (true);

drop policy if exists "teams_read_all" on public.teams;
create policy "teams_read_all" on public.teams for select to public using (true);

drop policy if exists "matches_read_all" on public.matches;
create policy "matches_read_all" on public.matches for select to public using (true);

drop policy if exists "schedule_templates_read_all" on public.schedule_templates;
create policy "schedule_templates_read_all" on public.schedule_templates for select to public using (true);

-- For MVP: allow inserts/updates on matches to any authenticated user
drop policy if exists "matches_write_authenticated" on public.matches;
create policy "matches_write_authenticated" on public.matches for insert to authenticated with check (true);

drop policy if exists "matches_update_authenticated" on public.matches;
create policy "matches_update_authenticated" on public.matches for update to authenticated using (true) with check (true);

-- Admin write access (authenticated) — split FOR ALL into explicit policies (do NOT use FOR ALL)
-- tournaments
drop policy if exists "tournaments_select_authenticated" on public.tournaments;
create policy "tournaments_select_authenticated" on public.tournaments for select to authenticated using (true);

drop policy if exists "tournaments_insert_authenticated" on public.tournaments;
create policy "tournaments_insert_authenticated" on public.tournaments for insert to authenticated with check (true);

drop policy if exists "tournaments_update_authenticated" on public.tournaments;
create policy "tournaments_update_authenticated" on public.tournaments for update to authenticated using (true) with check (true);

drop policy if exists "tournaments_delete_authenticated" on public.tournaments;
create policy "tournaments_delete_authenticated" on public.tournaments for delete to authenticated using (true);

-- pools
drop policy if exists "pools_select_authenticated" on public.pools;
create policy "pools_select_authenticated" on public.pools for select to authenticated using (true);

drop policy if exists "pools_insert_authenticated" on public.pools;
create policy "pools_insert_authenticated" on public.pools for insert to authenticated with check (true);

drop policy if exists "pools_update_authenticated" on public.pools;
create policy "pools_update_authenticated" on public.pools for update to authenticated using (true) with check (true);

drop policy if exists "pools_delete_authenticated" on public.pools;
create policy "pools_delete_authenticated" on public.pools for delete to authenticated using (true);

-- teams
drop policy if exists "teams_select_authenticated" on public.teams;
create policy "teams_select_authenticated" on public.teams for select to authenticated using (true);

drop policy if exists "teams_insert_authenticated" on public.teams;
create policy "teams_insert_authenticated" on public.teams for insert to authenticated with check (true);

drop policy if exists "teams_update_authenticated" on public.teams;
create policy "teams_update_authenticated" on public.teams for update to authenticated using (true) with check (true);

drop policy if exists "teams_delete_authenticated" on public.teams;
create policy "teams_delete_authenticated" on public.teams for delete to authenticated using (true);

-- schedule_templates
drop policy if exists "schedule_templates_select_authenticated" on public.schedule_templates;
create policy "schedule_templates_select_authenticated" on public.schedule_templates for select to authenticated using (true);

drop policy if exists "schedule_templates_insert_authenticated" on public.schedule_templates;
create policy "schedule_templates_insert_authenticated" on public.schedule_templates for insert to authenticated with check (true);

drop policy if exists "schedule_templates_update_authenticated" on public.schedule_templates;
create policy "schedule_templates_update_authenticated" on public.schedule_templates for update to authenticated using (true) with check (true);

drop policy if exists "schedule_templates_delete_authenticated" on public.schedule_templates;
create policy "schedule_templates_delete_authenticated" on public.schedule_templates for delete to authenticated using (true);

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