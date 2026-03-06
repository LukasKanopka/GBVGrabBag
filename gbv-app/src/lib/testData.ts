import supabase from './supabase';
import type { Tournament } from '../types/db';

export type FillResult = { updated: number; errors: string[] };

type MatchCandidate = {
  id: string;
  team1_id: string | null;
  team2_id: string | null;
};

type PoolRule = {
  setTarget: number;
  cap: number;
  winBy2: boolean;
  setTargetByPoolSize?: Record<string, number>;
};

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Generate a plausible single-set score adhering to pool rules.
 * - Respects target (e.g., 21), cap (e.g., 25), and winBy2 (true/false).
 * - Prefers realistic outcomes like 21–17, 21–19, or 22–20, 23–21; occasional 25–24 at cap.
 * Returns [winnerPoints, loserPoints].
 */
function generatePlausibleSet(target: number, cap: number, winBy2: boolean): [number, number] {
  const goDeuce = Math.random() < 0.35; // ~1/3 go beyond target

  if (!goDeuce) {
    const marginMin = winBy2 ? 2 : 1;
    const marginMax = Math.max(marginMin, Math.min(6, target - marginMin));
    const margin = randInt(marginMin, marginMax);
    const winner = target;
    const loser = Math.max(0, winner - margin);
    return [winner, loser];
  }

  // Deuce scenarios
  if (winBy2) {
    // Prefer two-point wins past target; occasionally hit cap with 1-point margin
    const useCapOnePoint = Math.random() < 0.2 && cap > target;
    if (useCapOnePoint) {
      const winner = cap;
      const loser = Math.max(0, cap - 1); // 25–24 style at cap
      return [winner, loser];
    }
    // Two-point beyond target but not exceeding cap
    const maxOvershoot = Math.max(1, Math.min(4, cap - target));
    let overshoot = randInt(1, maxOvershoot);
    let winner = target + overshoot;
    // Ensure winner within cap
    if (winner > cap) winner = cap;
    const loser = Math.max(0, winner - 2);
    // Guard for pathological caps like target==cap
    if (winner === target) {
      return [target, Math.max(0, target - 2)];
    }
    return [winner, loser];
  } else {
    // No win-by-2: any margin >=1 once target reached
    const winner = randInt(target, cap);
    const margin = randInt(1, Math.min(3, winner));
    const loser = Math.max(0, winner - margin);
    return [winner, loser];
  }
}

async function loadBasePoolRules(tournamentId: string): Promise<PoolRule> {
  const { data, error } = await supabase
    .from('tournaments')
    .select('id,game_rules')
    .eq('id', tournamentId)
    .single();
  if (error || !data) {
    return { setTarget: 21, cap: 99, winBy2: true, setTargetByPoolSize: { '3': 21, '4': 21, '5': 21, '6': 21 } };
  }
  const t = data as Tournament;
  const pool = (t.game_rules?.pool as any) || {};
  const setTarget = Number(pool.setTarget ?? 21);
  const cap = pool.cap == null ? 99 : Number(pool.cap);
  const winBy2 = Boolean(pool.winBy2 ?? true);
  const bySizeRaw = pool.setTargetByPoolSize;
  const setTargetByPoolSize =
    bySizeRaw && typeof bySizeRaw === 'object' && !Array.isArray(bySizeRaw)
      ? bySizeRaw as Record<string, number>
      : undefined;
  return { setTarget, cap, winBy2, setTargetByPoolSize };
}

function rulesForPoolSize(poolSize: number | null, base: PoolRule): PoolRule {
  if (poolSize != null) {
    const v = Number(base.setTargetByPoolSize?.[String(poolSize)]);
    if (Number.isFinite(v) && v > 0) return { ...base, setTarget: v };
  }
  return base;
}

/**
 * Fill all null-scored pool matches for the given tournament with plausible random scores (50/50 winners).
 * - Only updates matches where both team1_id and team2_id are present and both scores are null.
 * - Sets winner_id consistently with the generated scores.
 * - Clears any live scoring flags/values and sets is_live=false.
 */
export async function fillRandomPoolScores(tournamentId: string): Promise<FillResult> {
  const errors: string[] = [];
  const baseRules = await loadBasePoolRules(tournamentId);

  // Pool sizes (prefer pools.target_size; fallback to count teams assigned)
  const poolSizeById = new Map<string, number>();
  {
    const { data } = await supabase
      .from('pools')
      .select('id,target_size')
      .eq('tournament_id', tournamentId);
    for (const p of ((data as any[]) ?? [])) {
      const pid = String(p.id || '');
      const sz = Number(p.target_size);
      if (pid && Number.isFinite(sz) && sz > 0) poolSizeById.set(pid, sz);
    }
  }
  {
    const { data } = await supabase
      .from('teams')
      .select('id,pool_id')
      .eq('tournament_id', tournamentId);
    const counts = new Map<string, number>();
    for (const t of ((data as any[]) ?? [])) {
      const pid = t.pool_id ? String(t.pool_id) : '';
      if (!pid) continue;
      counts.set(pid, (counts.get(pid) ?? 0) + 1);
    }
    for (const [pid, c] of counts.entries()) {
      if (!poolSizeById.has(pid) && c > 0) poolSizeById.set(pid, c);
    }
  }

  // Fetch only null-scored pool matches with both teams assigned
  const { data, error } = await supabase
    .from('matches')
    .select('id,pool_id,team1_id,team2_id')
    .eq('tournament_id', tournamentId)
    .eq('match_type', 'pool')
    .is('team1_score', null)
    .is('team2_score', null)
    .not('team1_id', 'is', null)
    .not('team2_id', 'is', null);

  if (error) {
    return { updated: 0, errors: [`Failed to load matches: ${error.message}`] };
  }

  const candidates: Array<MatchCandidate & { pool_id?: string | null }> = (data as any[]) ?? [];
  let updated = 0;

  for (const m of candidates) {
    try {
      const sz = m.pool_id ? (poolSizeById.get(String(m.pool_id)) ?? null) : null;
      const rules = rulesForPoolSize(sz, baseRules);
      const [w, l] = generatePlausibleSet(rules.setTarget, rules.cap, rules.winBy2);
      const team1Wins = Math.random() < 0.5;
      const team1_score = team1Wins ? w : l;
      const team2_score = team1Wins ? l : w;
      const winner_id = team1Wins ? (m.team1_id as string) : (m.team2_id as string);

      const { error: upErr } = await supabase
        .from('matches')
        .update({
          team1_score,
          team2_score,
          winner_id,
          is_live: false,
          live_score_team1: null,
          live_score_team2: null,
        })
        .eq('id', m.id)
        .eq('match_type', 'pool');

      if (upErr) {
        errors.push(`Update failed for match ${m.id}: ${upErr.message}`);
        continue;
      }
      updated += 1;
    } catch (e: any) {
      errors.push(`Failed to score match ${m.id}: ${e?.message ?? String(e)}`);
    }
  }

  return { updated, errors };
}
