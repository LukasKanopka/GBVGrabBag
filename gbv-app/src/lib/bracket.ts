import supabase from './supabase';
import type { UUID, AdvancementRules, Tournament } from '../types/db';

/**
 * Bracket Engine — Policy A (extended)
 * - Advancers per pool follow tournament advancement_rules (defaults: 4-team => 2 advance, 5-team => 3 advance).
 * - Bracket size = next power of two (2,4,8,16,32,64) covering total advancers (supports up to 64).
 * - Award byes to top seeds; pre-fill later-round slots when a bye occurs.
 * - On generation: set tournaments.status='bracket', bracket_generated_at=now; keep bracket_started=false.
 * - Rebuild allowed only when bracket_started=false; else block.
 */

type TeamRec = {
  id: UUID;
  pool_id: UUID | null;
  full_team_name: string;
  seed_in_pool: number | null;
};

type MatchRec = {
  id: UUID;
  pool_id: UUID | null;
  team1_id: UUID | null;
  team2_id: UUID | null;
  team1_score: number | null;
  team2_score: number | null;
  winner_id: UUID | null;
  match_type: 'pool' | 'bracket';
};

type Standing = {
  teamId: UUID;
  name: string;
  wins: number;
  losses: number;
  played: number;
  setWon: number;
  setLost: number;
  setRatio: number;
  pointsFor: number;
  pointsAgainst: number;
  pointDiff: number;
  seed: number | null;
  poolId: UUID;
};

/**
 * Load tournament rules to get tiebreaker order; provide defaults if missing.
 */
async function loadTiebreakers(tournamentId: string): Promise<NonNullable<AdvancementRules['tiebreakers']>> {
  const { data, error } = await supabase
    .from('tournaments')
    .select('id,advancement_rules')
    .eq('id', tournamentId)
    .single();

  if (error || !data) {
    // Default per CURRENT_STATUS.md
    return ['head_to_head', 'set_ratio', 'point_diff', 'random'];
  }

  const rules = (data as Tournament).advancement_rules || {};
  const order = Array.isArray(rules.tiebreakers) && rules.tiebreakers.length
    ? rules.tiebreakers
    : ['head_to_head', 'set_ratio', 'point_diff', 'random'];
  return order as NonNullable<AdvancementRules['tiebreakers']>;
}

/**
 * Compute per-pool standings consistent with PublicPoolDetails.vue logic.
 * Returns a map of poolId -> sorted standings array.
 */
export async function computePoolStandings(tournamentId: string): Promise<Map<string, Standing[]>> {
  // Teams
  const { data: teamsData, error: teamsErr } = await supabase
    .from('teams')
    .select('id,pool_id,full_team_name,seed_in_pool')
    .eq('tournament_id', tournamentId);

  if (teamsErr) throw new Error(`Failed to load teams: ${teamsErr.message}`);

  const teams = (teamsData as TeamRec[]) ?? [];
  const byPoolTeams = new Map<string, TeamRec[]>();
  for (const t of teams) {
    if (!t.pool_id) continue;
    const arr = byPoolTeams.get(t.pool_id) ?? [];
    arr.push(t);
    byPoolTeams.set(t.pool_id, arr);
  }

  // Pool matches
  const { data: matchesData, error: matchesErr } = await supabase
    .from('matches')
    .select('id,pool_id,team1_id,team2_id,team1_score,team2_score,winner_id,match_type')
    .eq('tournament_id', tournamentId)
    .eq('match_type', 'pool');

  if (matchesErr) throw new Error(`Failed to load matches: ${matchesErr.message}`);

  const matches = (matchesData as MatchRec[]) ?? [];
  const byPoolMatches = new Map<string, MatchRec[]>();
  for (const m of matches) {
    if (!m.pool_id) continue;
    const arr = byPoolMatches.get(m.pool_id) ?? [];
    arr.push(m);
    byPoolMatches.set(m.pool_id, arr);
  }

  const tiebreakers = await loadTiebreakers(tournamentId);
  const result = new Map<string, Standing[]>();

  for (const [poolId, poolTeams] of byPoolTeams.entries()) {
    // Base stats
    const base: Record<string, Standing> = {};
    for (const t of poolTeams) {
      base[t.id] = {
        teamId: t.id,
        name: t.full_team_name,
        wins: 0,
        losses: 0,
        played: 0,
        setWon: 0,
        setLost: 0,
        setRatio: 0,
        pointsFor: 0,
        pointsAgainst: 0,
        pointDiff: 0,
        seed: t.seed_in_pool ?? null,
        poolId,
      };
    }

    // Aggregate from completed pool matches
    const pmatches = byPoolMatches.get(poolId) ?? [];
    for (const m of pmatches) {
      const completed = m.team1_score != null && m.team2_score != null;
      if (!completed) continue;
      const t1 = m.team1_id;
      const t2 = m.team2_id;
      if (!t1 || !t2) continue;
      const s1 = m.team1_score ?? 0;
      const s2 = m.team2_score ?? 0;

      if (base[t1]) {
        base[t1].played += 1;
        base[t1].pointsFor += s1;
        base[t1].pointsAgainst += s2;
        base[t1].pointDiff += (s1 - s2);
        if (m.winner_id === t1) {
          base[t1].wins += 1;
          base[t1].setWon += 1;
        } else {
          base[t1].losses += 1;
          base[t1].setLost += 1;
        }
      }
      if (base[t2]) {
        base[t2].played += 1;
        base[t2].pointsFor += s2;
        base[t2].pointsAgainst += s1;
        base[t2].pointDiff += (s2 - s1);
        if (m.winner_id === t2) {
          base[t2].wins += 1;
          base[t2].setWon += 1;
        } else {
          base[t2].losses += 1;
          base[t2].setLost += 1;
        }
      }
    }

    // Ratios
    for (const id of Object.keys(base)) {
      const st = base[id];
      const setsTotal = st.setWon + st.setLost;
      st.setRatio = setsTotal > 0 ? st.setWon / setsTotal : 0;
    }

    // Head-to-head helper within this pool
    function headToHead(aId: string, bId: string): number {
      const direct = (byPoolMatches.get(poolId) ?? []).find((m) => {
        const pair = new Set([m.team1_id, m.team2_id]);
        return pair.has(aId) && pair.has(bId) && m.team1_score != null && m.team2_score != null;
      });
      if (!direct) return 0;
      if (direct.winner_id === aId) return -1;
      if (direct.winner_id === bId) return 1;
      return 0;
    }

    function cmp(a: Standing, b: Standing): number {
      // Primary: wins desc
      if (b.wins !== a.wins) return b.wins - a.wins;

      for (const tb of tiebreakers) {
        if (tb === 'head_to_head') {
          // Only safe within the same pool; apply if exactly two-way tie on wins only
          const tieGroupWinsA = a.wins;
          const tieGroupWinsB = b.wins;
          if (tieGroupWinsA === tieGroupWinsB) {
            const h2h = headToHead(a.teamId, b.teamId);
            if (h2h !== 0) return h2h;
          }
        } else if (tb === 'set_ratio') {
          if (b.setRatio !== a.setRatio) return b.setRatio - a.setRatio;
        } else if (tb === 'point_diff') {
          if (b.pointDiff !== a.pointDiff) return b.pointDiff - a.pointDiff;
        } else if (tb === 'random') {
          // Keep deterministic fallback using teamId hash-ish compare instead of randomness
          const al = a.teamId.toString();
          const bl = b.teamId.toString();
          if (al !== bl) return al < bl ? -1 : 1;
        }
      }

      // Seed asc as last deterministic
      if (a.seed != null && b.seed != null && a.seed !== b.seed) return a.seed - b.seed;
      return a.name.localeCompare(b.name);
    }

    const arr = Object.values(base).sort(cmp);
    result.set(poolId, arr);
  }

  return result;
}

/**
 * Build the ordered seed list S = winners (globally ranked) + runners-up (globally ranked).
 * Returns array of team IDs in seed order (1-based).
 */
export async function seedAdvancers(tournamentId: string): Promise<{ seeds: UUID[]; winners: UUID[]; runners: UUID[] }> {
  const standingsByPool = await computePoolStandings(tournamentId);
  const tiebreakers = await loadTiebreakers(tournamentId);
  const advMap = await loadAdvancementPoolRules(tournamentId);

  // Comparator across pools using tiebreakers (H2H skipped cross-pool)
  function cmpGlobal(a: Standing, b: Standing): number {
    if (b.wins !== a.wins) return b.wins - a.wins;
    for (const tb of tiebreakers) {
      if (tb === 'head_to_head') {
        continue; // no cross-pool H2H
      } else if (tb === 'set_ratio') {
        if (b.setRatio !== a.setRatio) return b.setRatio - a.setRatio;
      } else if (tb === 'point_diff') {
        if (b.pointDiff !== a.pointDiff) return b.pointDiff - a.pointDiff;
      } else if (tb === 'random') {
        const al = a.teamId.toString();
        const bl = b.teamId.toString();
        if (al !== bl) return al < bl ? -1 : 1;
      }
    }
    if (a.seed != null && b.seed != null && a.seed !== b.seed) return a.seed - b.seed;
    return a.name.localeCompare(b.name);
  }

  // Bucket teams by finish position: 1st across pools, then 2nd across pools, then 3rd (for 5-team pools), etc.
  const poolIds = Array.from(standingsByPool.keys());
  const buckets: Standing[][] = [];

  for (const pid of poolIds) {
    const standings = standingsByPool.get(pid) ?? [];
    const size = standings.length;
    const advCount = advMap.get(size) ?? 0;
    for (let pos = 0; pos < advCount; pos++) {
      if (!buckets[pos]) buckets[pos] = [];
      if (standings[pos]) buckets[pos].push(standings[pos]);
    }
  }

  const orderedGroups: UUID[][] = [];
  for (const group of buckets) {
    if (!group || group.length === 0) continue;
    orderedGroups.push(group.sort(cmpGlobal).map((s) => s.teamId));
  }

  const seeds = ([] as UUID[]).concat(...orderedGroups);

  // For backwards compatibility, expose first two layers as winners/runners (may be empty arrays if not applicable)
  const winners = orderedGroups[0] ?? [];
  const runners = orderedGroups[1] ?? [];

  return { seeds, winners, runners };
}

/**
 * Utilities for bracket layout.
 */
function nextPowerOfTwoCeil(n: number, max: number = 64): number {
  if (n <= 1) return 2;
  let p = 1;
  while (p < n) p <<= 1;
  if (p > max) return -1;
  return p;
}

/**
 * Generate standard seed slot order for a power-of-two bracket size.
 * Uses a recursive pattern:
 *  B=2: [1,2]
 *  B=4: [1,4,2,3]
 *  B=8: [1,8,4,5,2,7,3,6]
 *  B=16: [1,16,8,9,4,13,5,12,2,15,7,10,3,14,6,11]
 */
function seedSlotsForSize(B: number): number[] {
  if (B < 2 || (B & (B - 1)) !== 0) throw new Error(`seedSlotsForSize requires power-of-two, got ${B}`);
  if (B === 2) return [1, 2];
  const prev = seedSlotsForSize(B >> 1);
  const res: number[] = [];
  for (const s of prev) {
    res.push(s);
    res.push(B + 1 - s);
  }
  return res;
}


/**
 * Generate bracket matches with byes applied.
 */
export async function generateBracket(tournamentId: string): Promise<{ inserted: number; bracketSize: number; rounds: number; errors: string[] }> {
  const errors: string[] = [];

  // Attempt to reset any existing bracket matches before generation.
  // Note: In some Supabase RLS configurations, delete may be a silent no-op (204, 0 rows) for anon users.
  // We use UPSERT later to avoid unique constraint failures even when deletes are blocked.
  {
    const { error: delErr } = await supabase
      .from('matches')
      .delete()
      .eq('tournament_id', tournamentId)
      .eq('match_type', 'bracket');
    if (delErr) {
      errors.push(`Failed to delete existing bracket (continuing with upsert): ${delErr.message}`);
    }
  }

  // Build seeds following advancement rules
  const { seeds } = await seedAdvancers(tournamentId);
  const N = seeds.length;

  if (N === 0) {
    return { inserted: 0, bracketSize: 0, rounds: 0, errors: ['No advancing teams found (check pool advancement rules and scores).'] };
  }

  const B = nextPowerOfTwoCeil(N, 64);
  if (B === -1) {
    return { inserted: 0, bracketSize: 0, rounds: 0, errors: ['Total advancers exceed supported bracket size (64).'] };
  }

  const rounds = Math.log2(B);

  // Map seed number (1-based) -> teamId or null and map into slot order
  const seedNumToTeam: (string | null)[] = Array.from({ length: B }, () => null);
  for (let seedNum = 1; seedNum <= N; seedNum++) {
    seedNumToTeam[seedNum - 1] = seeds[seedNum - 1];
  }
  const slotsSeedNums = seedSlotsForSize(B);
  const level0: (string | null)[] = slotsSeedNums.map((seedNum) => (seedNum <= N ? seedNumToTeam[seedNum - 1] : null));

  // Prepare rows to insert
  let totalInserted = 0;
  const rows: any[] = [];
  const seenKeys = new Set<string>();

  function pushRow(bracket_round: number, bracket_match_index: number, team1_id: string | null, team2_id: string | null) {
    const k = `${bracket_round}:${bracket_match_index}`;
    if (seenKeys.has(k)) {
      // Avoid duplicate (round, index) which violates matches_bracket_round_index_uidx
      return;
    }
    seenKeys.add(k);
    rows.push({
      tournament_id: tournamentId,
      pool_id: null,
      round_number: bracket_round,
      team1_id,
      team2_id,
      ref_team_id: null,
      team1_score: null,
      team2_score: null,
      winner_id: null,
      match_type: 'bracket',
      bracket_round,
      bracket_match_index,
      is_live: false,
      live_score_team1: null,
      live_score_team2: null,
    });
  }

  // Build bracket with preliminary matches.
  // We ALWAYS create R1 matches for any seeded position, even if it's a BYE (User A vs null).
  // The auto-resolver at the end of this function will detect the BYE, set the winner, and move them to R2.
  const r1Pairs = B >> 1;      // standard total R1 pairs in a full bracket

  // Create Round 1 matches
  for (let i = 0; i < r1Pairs; i++) {
    const a = level0[2 * i] ?? null;
    const b = level0[2 * i + 1] ?? null;

    if (a || b) {
      // Create match if at least one team is present (standard or BYE)
      pushRow(1, i, a, b);
    }
    // If both null (empty bracket slot), we create nothing? 
    // Actually, usually standard brackets are fully populated or empty. 
    // If seeds are sparse, unused slots remain empty.
  }

  // Create later rounds as TBD (starting from Round 2)
  for (let r = 2; r <= rounds; r++) {
    const matchCount = B >> r;
    for (let i = 0; i < matchCount; i++) {
      pushRow(r, i, null, null);
    }
  }

  if (rows.length > 0) {
    // Use upsert to avoid duplicate key failures when delete is blocked by RLS (or races).
    const { error: upsertErr } = await supabase
      .from('matches')
      .upsert(rows, { onConflict: 'tournament_id,bracket_round,bracket_match_index' });

    if (upsertErr) {
      errors.push(`Failed to insert bracket matches: ${upsertErr.message}`);
    } else {
      totalInserted += rows.length;

      // Best-effort cleanup: delete any old bracket matches not in this generated key-set.
      // (If delete is blocked by RLS, this may silently no-op; bracket rendering will still be correct
      // as long as bracket size/rounds are stable.)
      try {
        const allowedKeys = new Set<string>(rows.map((r) => `${r.bracket_round}:${r.bracket_match_index}`));
        const { data: existing, error: exErr } = await supabase
          .from('matches')
          .select('id, bracket_round, bracket_match_index')
          .eq('tournament_id', tournamentId)
          .eq('match_type', 'bracket');
        if (!exErr && Array.isArray(existing)) {
          const toDelete = existing
            .filter((m: any) => m.bracket_round != null && m.bracket_match_index != null)
            .filter((m: any) => !allowedKeys.has(`${m.bracket_round}:${m.bracket_match_index}`))
            .map((m: any) => m.id as string);
          if (toDelete.length) {
            const { error: delExtraErr } = await supabase
              .from('matches')
              .delete()
              .in('id', toDelete)
              .eq('match_type', 'bracket');
            if (delExtraErr) {
              errors.push(`Failed to remove stale bracket matches: ${delExtraErr.message}`);
            }
          }
        } else if (exErr) {
          errors.push(`Failed to verify bracket matches after upsert: ${exErr.message}`);
        }
      } catch (e: any) {
        errors.push(`Bracket cleanup failed: ${e?.message ?? String(e)}`);
      }

      // Auto-resolve Round 1 BYEs one level forward only (no cascading)
      try {
        const { data: all, error: loadErr } = await supabase
          .from('matches')
          .select('id,bracket_round,bracket_match_index,team1_id,team2_id,winner_id')
          .eq('tournament_id', tournamentId)
          .eq('match_type', 'bracket');

        if (!loadErr && Array.isArray(all)) {
          const byKey = new Map<string, any>();
          for (const m of all) {
            if (m.bracket_round != null && m.bracket_match_index != null) {
              byKey.set(`${m.bracket_round}:${m.bracket_match_index}`, m);
            }
          }

          for (const m of all) {
            if (m.bracket_round !== 1) continue;
            const a = m.team1_id as string | null;
            const b = m.team2_id as string | null;
            const hasA = !!a;
            const hasB = !!b;
            const exactlyOne = (hasA && !hasB) || (!hasA && hasB);
            if (!exactlyOne || m.winner_id) continue;

            const winnerId = (hasA ? a : b) as string;

            // Set winner on the BYE match
            await supabase
              .from('matches')
              .update({ winner_id: winnerId })
              .eq('id', m.id)
              .eq('match_type', 'bracket');

            // Place winner into next round (R2) appropriate side, if empty
            const nextRound = 2;
            const nextIndex = Math.floor((m.bracket_match_index as number) / 2);
            const side = ((m.bracket_match_index as number) % 2 === 0) ? 'team1_id' : 'team2_id';
            const next = byKey.get(`${nextRound}:${nextIndex}`) as any | undefined;
            if (next) {
              const curVal = side === 'team1_id' ? next.team1_id : next.team2_id;
              if (!curVal) {
                const { error: upNextErr } = await supabase
                  .from('matches')
                  .update(side === 'team1_id' ? { team1_id: winnerId } : { team2_id: winnerId })
                  .eq('id', next.id)
                  .eq('match_type', 'bracket');
                if (!upNextErr) {
                  // keep memory in sync to avoid duplicate work
                  if (side === 'team1_id') next.team1_id = winnerId;
                  else next.team2_id = winnerId;
                }
              }
            }
          }
        } else if (loadErr) {
          errors.push(`Failed to load bracket matches for BYE processing: ${loadErr.message}`);
        }
      } catch (e: any) {
        errors.push(`BYE auto-advance failed: ${e?.message ?? String(e)}`);
      }
    }
  }

  // Update tournament phase and timestamp (keep bracket_started=false)
  {
    const { error: upErr } = await supabase
      .from('tournaments')
      .update({ status: 'bracket', bracket_generated_at: new Date().toISOString() })
      .eq('id', tournamentId);

    if (upErr) errors.push(`Failed to update tournament status: ${upErr.message}`);
  }

  return { inserted: totalInserted, bracketSize: B, rounds, errors };
}

/**
 * Load advancement counts per pool size from tournament rules.
 * Defaults: 4-team => 2 advance, 5-team => 3 advance.
 */
async function loadAdvancementPoolRules(tournamentId: string): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  // defaults
  map.set(4, 2);
  map.set(5, 3);

  const { data, error } = await supabase
    .from('tournaments')
    .select('id,advancement_rules')
    .eq('id', tournamentId)
    .single();

  if (!error && data) {
    const adv = (data as Tournament).advancement_rules || {};
    const pools = Array.isArray((adv as any).pools) ? (adv as any).pools as Array<{ fromPoolSize: number; advanceCount: number }> : [];
    for (const r of pools) {
      const size = Number(r.fromPoolSize);
      const count = Number(r.advanceCount);
      if (Number.isFinite(size) && Number.isFinite(count) && size >= 2 && count >= 1) {
        map.set(size, count);
      }
    }
  }

  return map;
}

export type BracketPrereqReport = {
  ok: boolean;
  errors: string[];
  infos: string[];
  stats: {
    poolCount: number;
    teamCount: number;
    unscoredCount: number;
    expectedAdvancers: number;
    actualAdvancers: number;
    bracketExists: boolean;
    bracketSize: number; // -1 if unsupported
    rounds: number;      // 0 if unknown
  };
  unscored: Array<{ matchId: string; poolId: string | null; poolName: string | null }>;
  teamsWithoutPool: number;
};

/**
 * Check whether the tournament is ready to build a bracket and report precise blockers.
 * - Pools must have >= 2 teams each (those with <2 are flagged).
 * - All pool matches must be scored (both team1_score and team2_score present when both teams are assigned).
 * - If no blockers, compute actual advancers via seedAdvancers() and report suggested bracket size/rounds.
 * - Flags when a bracket already exists (user should rebuild when allowed).
 * - Notes when default tiebreakers will be used.
 */
export async function checkBracketPrerequisites(tournamentId: string): Promise<BracketPrereqReport> {
  const errors: string[] = [];
  const infos: string[] = [];

  // Load tournament advancement rules to detect defaults usage
  let usingDefaultTiebreakers = false;
  {
    const { data, error } = await supabase
      .from('tournaments')
      .select('id,advancement_rules')
      .eq('id', tournamentId)
      .single();
    if (!error && data) {
      const adv = (data as Tournament).advancement_rules || {};
      if (!Array.isArray((adv as any).tiebreakers) || ((adv as any).tiebreakers || []).length === 0) {
        usingDefaultTiebreakers = true;
      }
    }
  }
  if (usingDefaultTiebreakers) {
    infos.push('Using default tiebreakers: head_to_head, set_ratio, point_diff, random.');
  }

  // Advancement mapping
  const advMap = await loadAdvancementPoolRules(tournamentId);
  const supportedSizes = Array.from(advMap.keys()).sort((a, b) => a - b);

  // Load pools
  const { data: poolsData, error: poolsErr } = await supabase
    .from('pools')
    .select('id,name')
    .eq('tournament_id', tournamentId);
  if (poolsErr) {
    return {
      ok: false,
      errors: [`Failed to load pools: ${poolsErr.message}`],
      infos,
      stats: {
        poolCount: 0,
        teamCount: 0,
        unscoredCount: 0,
        expectedAdvancers: 0,
        actualAdvancers: 0,
        bracketExists: false,
        bracketSize: 0,
        rounds: 0,
      },
      unscored: [],
      teamsWithoutPool: 0,
    };
  }
  const pools = (poolsData as Array<{ id: string; name: string }>) ?? [];
  const poolNameById = new Map<string, string>();
  for (const p of pools) poolNameById.set(p.id, p.name);

  // Load teams
  const { data: teamsData, error: teamsErr } = await supabase
    .from('teams')
    .select('id,pool_id')
    .eq('tournament_id', tournamentId);
  if (teamsErr) {
    return {
      ok: false,
      errors: [`Failed to load teams: ${teamsErr.message}`],
      infos,
      stats: {
        poolCount: pools.length,
        teamCount: 0,
        unscoredCount: 0,
        expectedAdvancers: 0,
        actualAdvancers: 0,
        bracketExists: false,
        bracketSize: 0,
        rounds: 0,
      },
      unscored: [],
      teamsWithoutPool: 0,
    };
  }
  const teams = (teamsData as Array<{ id: string; pool_id: string | null }>) ?? [];
  const teamCount = teams.length;
  const teamsByPoolCount = new Map<string, number>();
  let teamsWithoutPool = 0;
  for (const t of teams) {
    if (!t.pool_id) {
      teamsWithoutPool += 1;
      continue;
    }
    teamsByPoolCount.set(t.pool_id, (teamsByPoolCount.get(t.pool_id) ?? 0) + 1);
  }

  // Validate pool sizes and compute expected advancers from rules
  let expectedAdvancers = 0;
  for (const p of pools) {
    const sz = teamsByPoolCount.get(p.id) ?? 0;
    if (sz < 2) {
      errors.push(`Pool '${p.name}' has only ${sz} team(s). Need at least 2 to advance.`);
      continue;
    }
    const adv = advMap.get(sz) ?? 0;
    if (adv === 0) {
      errors.push(`Unsupported pool size ${sz} in '${p.name}' for advancement. Supported: ${supportedSizes.join(', ')}.`);
      continue;
    }
    expectedAdvancers += adv;
  }
  if (teamsWithoutPool > 0) {
    infos.push(`${teamsWithoutPool} team(s) are not assigned to any pool.`);
  }

  // Load pool matches and find unscored
  const { data: matchesData, error: matchesErr } = await supabase
    .from('matches')
    .select('id,pool_id,team1_id,team2_id,team1_score,team2_score,match_type')
    .eq('tournament_id', tournamentId)
    .eq('match_type', 'pool');
  if (matchesErr) {
    return {
      ok: false,
      errors: [`Failed to load pool matches: ${matchesErr.message}`],
      infos,
      stats: {
        poolCount: pools.length,
        teamCount,
        unscoredCount: 0,
        expectedAdvancers,
        actualAdvancers: 0,
        bracketExists: false,
        bracketSize: 0,
        rounds: 0,
      },
      unscored: [],
      teamsWithoutPool,
    };
  }
  const poolMatches = (matchesData as Array<{
    id: string;
    pool_id: string | null;
    team1_id: string | null;
    team2_id: string | null;
    team1_score: number | null;
    team2_score: number | null;
    match_type: 'pool' | 'bracket';
  }>) ?? [];

  const unscored: Array<{ matchId: string; poolId: string | null; poolName: string | null }> = [];
  for (const m of poolMatches) {
    const bothTeamsAssigned = m.team1_id != null && m.team2_id != null;
    const anyScoreMissing = m.team1_score == null || m.team2_score == null;
    if (bothTeamsAssigned && anyScoreMissing) {
      unscored.push({
        matchId: m.id,
        poolId: m.pool_id,
        poolName: m.pool_id ? (poolNameById.get(m.pool_id) ?? null) : null,
      });
    }
  }
  const unscoredCount = unscored.length;
  if (unscoredCount > 0) {
    errors.push(`${unscoredCount} pool match(es) are missing scores.`);
  }

  // Check if a bracket already exists
  let bracketExists = false;
  {
    const { data: existing, error } = await supabase
      .from('matches')
      .select('id')
      .eq('tournament_id', tournamentId)
      .eq('match_type', 'bracket')
      .limit(1);
    if (!error) {
      bracketExists = (existing ?? []).length > 0;
      if (bracketExists) {
        errors.push('Bracket already exists. Use Rebuild Bracket to overwrite when allowed.');
      }
    }
  }

  // Compute actual advancers only when there are no unscored matches and no size errors
  let actualAdvancers = 0;
  let bracketSize = 0;
  let rounds = 0;

  if (errors.filter(e => e.includes('Pool') || e.includes('Unsupported pool size')).length === 0 && unscoredCount === 0) {
    try {
      const { seeds } = await seedAdvancers(tournamentId);
      actualAdvancers = seeds.length;

      if (actualAdvancers === 0) {
        errors.push('No advancing teams found (check pool advancement rules and scores).');
      } else {
        const B = nextPowerOfTwoCeil(actualAdvancers, 64);
        bracketSize = B;
        rounds = B > 0 ? Math.log2(B) : 0;
        if (B === -1) {
          errors.push('Total advancers exceed supported bracket size (64).');
        }
      }
    } catch (e: any) {
      errors.push(`Failed to compute advancers: ${e?.message ?? String(e)}`);
    }
  }

  // Inconsistencies
  if (expectedAdvancers >= 2 && actualAdvancers > 0 && actualAdvancers !== expectedAdvancers) {
    infos.push(`Expected ${expectedAdvancers} advancers (per pool rules), computed ${actualAdvancers}.`);
  }

  return {
    ok: errors.length === 0,
    errors,
    infos,
    stats: {
      poolCount: pools.length,
      teamCount,
      unscoredCount,
      expectedAdvancers,
      actualAdvancers,
      bracketExists,
      bracketSize,
      rounds,
    },
    unscored,
    teamsWithoutPool,
  };
}

/**
 * Rebuild bracket unconditionally (always deletes existing bracket matches, then regenerates).
 * Warning: this will wipe existing bracket matches and any recorded scores.
 */
export async function rebuildBracket(tournamentId: string): Promise<{ inserted: number; bracketSize: number; rounds: number; errors: string[] }> {

  // Delete existing bracket matches (if any)
  const { error: delErr } = await supabase
    .from('matches')
    .delete()
    .eq('tournament_id', tournamentId)
    .eq('match_type', 'bracket');

  if (delErr) {
    return { inserted: 0, bracketSize: 0, rounds: 0, errors: [`Failed to delete existing bracket: ${delErr.message}`] };
  }

  // Generate again
  return await generateBracket(tournamentId);
}

// --- Auto-advance winner into next round helper (appended) ---
export async function advanceWinnerToNextById(tournamentId: string, matchId: string): Promise<{ updatedNext: boolean; error?: string }> {
  try {
    // Load current match minimal fields
    const { data: m, error: mErr } = await supabase
      .from('matches')
      .select('id, match_type, bracket_round, bracket_match_index, winner_id')
      .eq('tournament_id', tournamentId)
      .eq('id', matchId)
      .single();

    if (mErr || !m) {
      return { updatedNext: false, error: mErr?.message || 'Match not found' };
    }
    if (m.match_type !== 'bracket' || m.bracket_round == null || m.bracket_match_index == null) {
      return { updatedNext: false, error: 'Not a bracket match or missing bracket indices' };
    }
    if (!m.winner_id) {
      return { updatedNext: false, error: 'Winner not set' };
    }

    const curIndex: number = m.bracket_match_index as number;
    const nextRound: number = (m.bracket_round as number) + 1;
    const nextIndex: number = Math.floor(curIndex / 2);
    const side: 'team1_id' | 'team2_id' = (curIndex % 2 === 0) ? 'team1_id' : 'team2_id';

    // Load next round target match
    const { data: next, error: nErr } = await supabase
      .from('matches')
      .select('id, team1_id, team2_id')
      .eq('tournament_id', tournamentId)
      .eq('match_type', 'bracket')
      .eq('bracket_round', nextRound)
      .eq('bracket_match_index', nextIndex)
      .single();

    // If next match not found (i.e., final already), nothing to update
    if (nErr || !next) {
      return { updatedNext: false, error: nErr?.message || 'No next match (final or missing row)' };
    }

    // Do not overwrite if already set to a different team (respect manual control)
    const currentVal = side === 'team1_id' ? next.team1_id : next.team2_id;
    if (currentVal && currentVal !== m.winner_id) {
      return { updatedNext: false, error: 'Next slot already filled by a different team; not overwriting' };
    }
    if (currentVal === m.winner_id) {
      return { updatedNext: false }; // Already set correctly
    }

    const updatePayload = side === 'team1_id' ? { team1_id: m.winner_id } : { team2_id: m.winner_id };
    const { error: upErr } = await supabase
      .from('matches')
      .update(updatePayload)
      .eq('id', next.id)
      .eq('match_type', 'bracket');

    if (upErr) {
      return { updatedNext: false, error: upErr.message };
    }
    return { updatedNext: true };
  } catch (e: any) {
    return { updatedNext: false, error: e?.message ?? String(e) };
  }
}
