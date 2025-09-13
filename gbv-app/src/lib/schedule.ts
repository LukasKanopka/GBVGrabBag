import supabase from './supabase';
import type { ScheduleTemplateRound } from '../types/db';

type TeamRec = {
  id: string;
  pool_id: string | null;
  seed_in_pool: number | null;
  partner_name: string | null;
  full_team_name: string;
};

type PoolRec = {
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

  const { data: teams, error: teamsErr } = await supabase
    .from('teams')
    .select('id,pool_id,seed_in_pool,partner_name,full_team_name')
    .eq('tournament_id', tournamentId);

  if (teamsErr) return { ok: false, errors: [`Failed to load teams: ${teamsErr.message}`] };

  // 1) Partners must be assigned for all seeded players
  const missingPartners = (teams as TeamRec[]).filter(t => t.partner_name == null || t.partner_name.trim() === '');
  if (missingPartners.length > 0) {
    errors.push(`Partner assignment incomplete: ${missingPartners.length} team(s) missing partner_name.`);
  }

  // 2) Schedule templates must exist for each pool size
  const poolSizeToCount = new Map<string, number>(); // key = pool_id, value = size
  for (const t of teams as TeamRec[]) {
    if (!t.pool_id) continue;
    poolSizeToCount.set(t.pool_id, (poolSizeToCount.get(t.pool_id) ?? 0) + 1);
  }

  const sizesNeeded = Array.from(new Set(Array.from(poolSizeToCount.values()))).sort((a, b) => a - b);

  // Enforce supported pool sizes (3–5)
  const allowedSizes = new Set<number>([3, 4, 5]);
  const invalidSizes = sizesNeeded.filter((sz) => !allowedSizes.has(sz));
  for (const sz of invalidSizes) {
    errors.push(`Unsupported pool size ${sz}. Only 3–5 are supported.`);
  }

  // Check templates for supported sizes only
  for (const sz of sizesNeeded.filter((s) => allowedSizes.has(s))) {
    const { data: tmpl, error: tmplErr } = await supabase
      .from('schedule_templates')
      .select('id')
      .eq('tournament_id', tournamentId)
      .eq('pool_size', sz)
      .maybeSingle();

    if (tmplErr || !tmpl) {
      errors.push(`Missing schedule template for pool size ${sz}.`);
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
    .select('id,pool_id,seed_in_pool,partner_name,full_team_name')
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