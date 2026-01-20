import supabase from './supabase';
import type { ScheduleTemplateRound } from '../types/db';
import { defaultTemplateForPoolSize } from './defaultTemplates';

type TeamRec = {
  id: string;
  pool_id: string | null;
  seed_in_pool: number | null;
  seeded_player_name: string;
  full_team_name: string;
};

type PoolRec = {
  id: string;
  name: string;
};

type PoolNameRec = {
  id: string;
  name: string;
};

type TemplateRec = {
  template_data: ScheduleTemplateRound[];
};

export type GenerateResult = {
  inserted: number;
  errors: string[];
};

function bySeed(teams: TeamRec[]) {
  const map = new Map<number, TeamRec>();
  for (const t of teams) {
    if (t.seed_in_pool != null) {
      map.set(t.seed_in_pool, t);
    }
  }
  return map;
}

export async function checkPrerequisites(tournamentId: string): Promise<{ ok: boolean; errors: string[] }> {
  const errors: string[] = [];

  const { data: poolsData, error: poolsErr } = await supabase
    .from('pools')
    .select('id,name')
    .eq('tournament_id', tournamentId);

  const poolNameById = new Map<string, string>();
  if (poolsErr) {
    errors.push(`Failed to load pools: ${poolsErr.message}`);
  } else {
    for (const p of ((poolsData as PoolNameRec[]) ?? [])) {
      poolNameById.set(p.id, p.name);
    }
  }

  const { data: teams, error: teamsErr } = await supabase
    .from('teams')
    .select('id,pool_id,seed_in_pool,seeded_player_name,full_team_name')
    .eq('tournament_id', tournamentId);

  if (teamsErr) return { ok: false, errors: [`Failed to load teams: ${teamsErr.message}`] };

  const teamRows = (teams as TeamRec[]) ?? [];

  // 1) Teams must have a "real" team name (not just the seeded player)
  const missingTeamNames = teamRows.filter((t) => {
    const seeded = (t.seeded_player_name || '').trim().toLowerCase();
    const full = (t.full_team_name || '').trim().toLowerCase();
    return !seeded || !full || full === seeded;
  });
  if (missingTeamNames.length > 0) {
    errors.push(`Team naming incomplete: ${missingTeamNames.length} team(s) missing a second player or team name.`);
  }

  // 2) Schedule templates must exist for each pool size
  const poolSizeToCount = new Map<string, number>(); // key = pool_id, value = size
  for (const t of teamRows) {
    if (!t.pool_id) continue;
    poolSizeToCount.set(t.pool_id, (poolSizeToCount.get(t.pool_id) ?? 0) + 1);
  }

  // 2b) Every team in a scheduled pool must have a valid seed (1..pool size), else schedule generation maps to null teams.
  for (const [poolId, poolSize] of poolSizeToCount.entries()) {
    const poolLabel = poolNameById.get(poolId) ?? `Pool ${poolId.slice(0, 8)}…`;
    const group = teamRows.filter((t) => t.pool_id === poolId);

    const missingSeedTeams = group.filter((t) => t.seed_in_pool == null);
    if (missingSeedTeams.length > 0) {
      const names = missingSeedTeams
        .map((t) => (t.full_team_name || t.seeded_player_name || '').trim())
        .filter(Boolean)
        .slice(0, 6);
      const suffix = missingSeedTeams.length > names.length ? `, …(+${missingSeedTeams.length - names.length} more)` : '';
      errors.push(`Missing pool seeds: ${poolLabel} has ${missingSeedTeams.length} team(s) without a seed${names.length ? ` (${names.join(', ')}${suffix})` : ''}.`);
      continue;
    }

    const seeds = group.map((t) => t.seed_in_pool).filter((n): n is number => n != null);
    const seen = new Set<number>();
    const duplicates = new Set<number>();
    for (const n of seeds) {
      if (seen.has(n)) duplicates.add(n);
      seen.add(n);
    }
    if (duplicates.size > 0) {
      const dup = Array.from(duplicates).sort((a, b) => a - b);
      errors.push(`Duplicate pool seeds: ${poolLabel} has duplicate seed(s): ${dup.join(', ')}.`);
    }

    // If all teams have seeds, ensure they're in the valid range for the pool size.
    const outOfRange = seeds.filter((n) => !Number.isInteger(n) || n < 1 || n > poolSize);

    if (outOfRange.length > 0) {
      const uniq = Array.from(new Set(outOfRange)).sort((a, b) => a - b);
      errors.push(`Invalid pool seeds: ${poolLabel} seeds must be 1–${poolSize}. Found ${uniq.join(', ')}.`);
    }
  }

  const sizesNeeded = Array.from(new Set(Array.from(poolSizeToCount.values()))).sort((a, b) => a - b);

  // Enforce supported pool sizes (4–5)
  const allowedSizes = new Set<number>([4, 5]);
  const invalidSizes = sizesNeeded.filter((sz) => !allowedSizes.has(sz));
  for (const sz of invalidSizes) {
    errors.push(`Unsupported pool size ${sz}. Only 4–5 are supported.`);
  }

  // Ensure templates exist or auto-seed for supported sizes
  for (const sz of sizesNeeded.filter((s) => allowedSizes.has(s))) {
    const { data: tmpl, error: tmplErr } = await supabase
      .from('schedule_templates')
      .select('id')
      .eq('tournament_id', tournamentId)
      .eq('pool_size', sz)
      .maybeSingle();

    // Auto-seed if missing
    if (tmplErr || !tmpl) {
      const defaults = defaultTemplateForPoolSize(sz);
      if (defaults.length > 0) {
        const { error: upErr } = await supabase
          .from('schedule_templates')
          .upsert(
            {
              tournament_id: tournamentId,
              pool_size: sz,
              template_data: defaults,
            },
            { onConflict: 'tournament_id,pool_size' }
          );
        if (upErr) {
          errors.push(`Missing schedule template for pool size ${sz} and failed to auto-create: ${upErr.message}`);
        }
      } else {
        errors.push(`Missing schedule template for pool size ${sz}.`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

export async function generateSchedule(tournamentId: string): Promise<GenerateResult> {
  const prereq = await checkPrerequisites(tournamentId);
  if (!prereq.ok) return { inserted: 0, errors: prereq.errors };

  const { data: poolsData, error: poolsErr } = await supabase
    .from('pools')
    .select('id,name')
    .eq('tournament_id', tournamentId);

  if (poolsErr) return { inserted: 0, errors: [`Failed to load pools: ${poolsErr.message}`] };

  const pools = (poolsData as PoolRec[]) ?? [];

  const { data: teamsData, error: teamsErr } = await supabase
    .from('teams')
    .select('id,pool_id,seed_in_pool,seeded_player_name,full_team_name')
    .eq('tournament_id', tournamentId);

  if (teamsErr) return { inserted: 0, errors: [`Failed to load teams: ${teamsErr.message}`] };

  const teams = (teamsData as TeamRec[]) ?? [];

  // Group teams by pool
  const teamsByPool = new Map<string, TeamRec[]>();
  for (const t of teams) {
    if (!t.pool_id) continue;
    const arr = teamsByPool.get(t.pool_id) ?? [];
    arr.push(t);
    teamsByPool.set(t.pool_id, arr);
  }

  let totalInserted = 0;
  const errors: string[] = [];

  for (const p of pools) {
    const group = (teamsByPool.get(p.id) ?? []).slice().sort((a, b) => (a.seed_in_pool ?? 0) - (b.seed_in_pool ?? 0));
    const poolSize = group.length;
    if (poolSize < 2) {
      // Not enough teams to schedule
      continue;
    }

    // Load template for this pool size
    const { data: tmpl, error: tmplErr } = await supabase
      .from('schedule_templates')
      .select('template_data')
      .eq('tournament_id', tournamentId)
      .eq('pool_size', poolSize)
      .maybeSingle();

    if (tmplErr || !tmpl) {
      errors.push(`Missing schedule template for pool '${p.name}' (size ${poolSize}).`);
      continue;
    }

    const template = (tmpl as TemplateRec).template_data ?? [];
    const seedMap = bySeed(group);

    // Build match rows
    const rows: any[] = [];
    for (const round of template) {
      const plays = round.play ?? [];
      const refs = round.ref ?? []; // optional array aligned by play index (if present)
      for (let i = 0; i < plays.length; i++) {
        const pair = plays[i];
        if (!Array.isArray(pair) || pair.length !== 2) continue;
        const seedA = Number(pair[0]);
        const seedB = Number(pair[1]);

        const t1 = seedMap.get(seedA) ?? null;
        const t2 = seedMap.get(seedB) ?? null;

        const refSeed = Array.isArray(refs) ? Number(refs[i]) : NaN;
        const refTeam = !Number.isNaN(refSeed) ? (seedMap.get(refSeed) ?? null) : null;

        rows.push({
          tournament_id: tournamentId,
          pool_id: p.id,
          round_number: round.round ?? null,
          team1_id: t1 ? t1.id : null,
          team2_id: t2 ? t2.id : null,
          ref_team_id: refTeam ? refTeam.id : null,
          team1_score: null,
          team2_score: null,
          winner_id: null,
          match_type: 'pool',
          bracket_round: null,
          is_live: false,
          live_score_team1: null,
          live_score_team2: null,
        });
      }
    }

    if (rows.length === 0) continue;

    const { error: insertErr } = await supabase.from('matches').insert(rows);
    if (insertErr) {
      errors.push(`Failed to insert matches for pool '${p.name}': ${insertErr.message}`);
    } else {
      totalInserted += rows.length;
    }
  }

  return { inserted: totalInserted, errors };
}
