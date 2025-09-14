import supabase from './supabase';
import type { GameRules, Tournament, UUID } from '../types/db';

type MatchCandidate = {
  id: UUID;
  team1_id: UUID | null;
  team2_id: UUID | null;
};

type PoolRuleShape = {
  target: number;  // setTarget
  cap: number;     // cap
  winBy2: boolean; // winBy2
};

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Load pool game rules with sensible defaults when missing.
 */
async function loadPoolRules(tournamentId: string): Promise<PoolRuleShape> {
  const { data, error } = await supabase
    .from('tournaments')
    .select('id,game_rules')
    .eq('id', tournamentId)
    .single();

  const defaults: PoolRuleShape = { target: 21, cap: 25, winBy2: true };

  if (error || !data) return defaults;

  const t = data as Tournament;
  const pool = (t.game_rules as GameRules | null)?.pool;
  const target = Number(pool?.setTarget ?? defaults.target) || defaults.target;
  const cap = Number(pool?.cap ?? defaults.cap) || defaults.cap;
  const winBy2 = typeof pool?.winBy2 === 'boolean' ? pool!.winBy2! : defaults.winBy2;

  // Ensure cap is at least target (and not absurd)
  const saneCap = Math.max(target, cap);
  // Hard clamp to a reasonable upper bound to avoid extreme scores if misconfigured
  const hardCap = clamp(saneCap, target, target + 10);

  return { target, cap: hardCap, winBy2 };
}

type WinnerLoserScore = { winner: number; loser: number };

/**
 * Generate a single-set plausible score respecting target/cap/winBy2.
 * Examples with defaults:
 * - 21-17, 21-18 (margin ≥ 2)
 * - 22-20, 23-21 (deuce beyond target, margin 2)
 * - 25-24 (cap reached, margin 1 allowed at cap)
 */
function generateSingleSetScore(r: PoolRuleShape): WinnerLoserScore {
  const target = r.target;
  const cap = r.cap;
  const winBy2 = r.winBy2;

  // Primary distributions (tuned to look realistic):
  // - 70%: finish at target with margin between 2..5 (e.g., 21-17, 21-19)
  // - 25%: deuce beyond target with margin 2 up to cap (e.g., 22-20, 23-21)
  // - 5%: cap-out one-point win (e.g., 25-24) even if winBy2 (cap rule)
  const roll = Math.random();

  if (winBy2) {
    if (roll < 0.70) {
      // Finish at target with margin 2..5
      const margin = randInt(2, 5);
      const loser = clamp(target - margin, Math.max(0, target - 10), target - 1);
      return { winner: target, loser };
    } else if (roll < 0.95) {
      // Beyond target, margin exactly 2, keep within cap (prefer k = 1..2)
      const kMax = Math.max(1, Math.floor((cap - target) / 2));
      const k = clamp(randInt(1, 2), 1, kMax);
      const winner = clamp(target + 2 * k, target + 2, cap);
      const loser = winner - 2;
      if (winner <= cap) {
        return { winner, loser };
      }
      // Fall through to cap scenario if exceeded
    }
    // Cap-out one-point win
    return { winner: cap, loser: Math.max(0, cap - 1) };
  } else {
    // No win-by-2: allow 1+ margins once at/over target
    const winner = roll < 0.8 ? target : clamp(target + randInt(1, 2), target, cap);
    const margin = randInt(1, 3);
    const loser = clamp(winner - margin, Math.max(0, target - 10), winner - 1);
    return { winner, loser };
  }
}

/**
 * Decide a 50/50 winner between team1 and team2 and produce final scores.
 */
function generateScoresForSides(r: PoolRuleShape): { team1_score: number; team2_score: number; winnerSide: 'team1' | 'team2' } {
  const base = generateSingleSetScore(r);
  const team1Wins = Math.random() < 0.5;
  if (team1Wins) {
    return { team1_score: base.winner, team2_score: base.loser, winnerSide: 'team1' };
  } else {
    return { team1_score: base.loser, team2_score: base.winner, winnerSide: 'team2' };
  }
}

/**
 * Fill all null-scored POOL matches with plausible random single-set scores.
 * - Only affects matches where both team IDs are present and both scores are null.
 * - Sets winner_id accordingly.
 * - Clears any live flags and live scores.
 *
 * Returns: { updated, errors }
 */
export async function fillRandomPoolScores(tournamentId: string): Promise<{ updated: number; errors: string[] }> {
  const errors: string[] = [];
  let updated = 0;

  const rules = await loadPoolRules(tournamentId);

  // Load candidate matches
  const { data, error } = await supabase
    .from('matches')
    .select('id,team1_id,team2_id')
    .eq('tournament_id', tournamentId)
    .eq('match_type', 'pool')
    .not('team1_id', 'is', null)
    .not('team2_id', 'is', null)
    .is('team1_score', null)
    .is('team2_score', null);

  if (error) {
    return { updated: 0, errors: [`Failed to load matches: ${error.message}`] };
  }

  const candidates: MatchCandidate[] = (data as MatchCandidate[]) ?? [];
  if (candidates.length === 0) {
    return { updated: 0, errors };
  }

  // Apply updates (sequential to keep it simple; dataset sizes are small per tournament)
  for (const m of candidates) {
    if (!m.team1_id || !m.team2_id) continue;

    const { team1_score, team2_score, winnerSide } = generateScoresForSides(rules);
    const winner_id = winnerSide === 'team1' ? m.team1_id : m.team2_id;

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
    } else {
      updated += 1;
    }
  }

  return { updated, errors };
}

export default fillRandomPoolScores;