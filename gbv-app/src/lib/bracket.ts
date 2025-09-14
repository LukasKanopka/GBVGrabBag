import supabase from './supabase';
import type { UUID, AdvancementRules, Tournament } from '../types/db';

/**
 * Bracket Engine — Policy A
 * - Top 2 advance from each pool: winners ranked globally, then runners-up ranked globally using tiebreakers.
 * - Bracket size = next power of two (2,4,8) covering total advancers (max 8 for MVP).
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

  // Flatten standings and build lookup by teamId
  const allStandings: Standing[] = [];
  const poolIds = Array.from(standingsByPool.keys());
  for (const pid of poolIds) {
    const s = standingsByPool.get(pid) ?? [];
    for (const st of s) allStandings.push(st);
  }
  const byTeam: Record<string, Standing> = {};
  for (const st of allStandings) byTeam[st.teamId] = st;

  // Winners and runners per pool
  const winnersList: Standing[] = [];
  const runnersList: Standing[] = [];
  for (const pid of poolIds) {
    const s = standingsByPool.get(pid) ?? [];
    if (s[0]) winnersList.push(s[0]);
    if (s[1]) runnersList.push(s[1]);
  }

  // Global comparator (cross-pool): wins desc, then tiebreakers except H2H rarely applies since no cross-pool matches
  function cmpGlobal(a: Standing, b: Standing): number {
    if (b.wins !== a.wins) return b.wins - a.wins;
    for (const tb of tiebreakers) {
      if (tb === 'head_to_head') {
        // No cross-pool head-to-head; skip
        continue;
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

  const winners = winnersList.sort(cmpGlobal).map((s) => s.teamId);
  const runners = runnersList.sort(cmpGlobal).map((s) => s.teamId);
  const seeds = winners.concat(runners);

  return { seeds, winners, runners };
}

/**
 * Utilities for bracket layout.
 */
function nextPowerOfTwoAtMost8(n: number): number {
  if (n <= 1) return 2;
  if (n <= 2) return 2;
  if (n <= 4) return 4;
  if (n <= 8) return 8;
  return -1; // unsupported
}

// Seed line orders per standard bracket seeding for B=2,4,8
function seedSlotsForSize(B: number): number[] {
  if (B === 2) return [1, 2];
  if (B === 4) return [1, 4, 2, 3];
  if (B === 8) return [1, 8, 4, 5, 3, 6, 2, 7];
  throw new Error(`Unsupported bracket size ${B}`);
}

// Return list of pair index tuples for Round 1 based on slot order
function round1PairsForSize(B: number): Array<[number, number]> {
  const slots = seedSlotsForSize(B);
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < slots.length; i += 2) {
    pairs.push([i, i + 1]);
  }
  return pairs;
}

/**
 * Generate bracket matches with byes applied.
 */
export async function generateBracket(tournamentId: string): Promise<{ inserted: number; bracketSize: number; rounds: number; errors: string[] }> {
  const errors: string[] = [];

  // Guard: existing bracket matches?
  {
    const { data: existing, error } = await supabase
      .from('matches')
      .select('id')
      .eq('tournament_id', tournamentId)
      .eq('match_type', 'bracket')
      .limit(1);

    if (error) return { inserted: 0, bracketSize: 0, rounds: 0, errors: [`Failed to check existing bracket: ${error.message}`] };
    if ((existing ?? []).length > 0) {
      return { inserted: 0, bracketSize: 0, rounds: 0, errors: ['Bracket already exists. Use rebuildBracket() to overwrite when allowed.'] };
    }
  }

  // Build seeds
  const { seeds } = await seedAdvancers(tournamentId);
  const N = seeds.length;

  if (N === 0) {
    return { inserted: 0, bracketSize: 0, rounds: 0, errors: ['No advancing teams found (need two per pool).'] };
  }

  const B = nextPowerOfTwoAtMost8(N);
  if (B === -1) {
    return { inserted: 0, bracketSize: 0, rounds: 0, errors: ['Total advancers exceed MVP bracket size (8). Reduce pools or wait for future support.'] };
  }

  const rounds = Math.log2(B);

  // Map seed number (1-based) -> teamId or null
  const seedNumToTeam: (string | null)[] = Array.from({ length: B }, () => null);
  for (let seedNum = 1; seedNum <= N; seedNum++) {
    seedNumToTeam[seedNum - 1] = seeds[seedNum - 1];
  }

  // Translate to slot order; slots are arranged by seeding pattern
  const slotsSeedNums = seedSlotsForSize(B); // e.g., for 8: [1,8,4,5,3,6,2,7]
  const slotTeams: (string | null)[] = slotsSeedNums.map((seedNum) => {
    return seedNum <= N ? seedNumToTeam[seedNum - 1] : null;
  });

  // Round 1 creation and carry-forwards
  type Pair = { aSlot: number; bSlot: number; aTeam: string | null; bTeam: string | null };
  const pairsIdx = round1PairsForSize(B);
  const r1Pairs: Pair[] = pairsIdx.map(([a, b]) => ({
    aSlot: a,
    bSlot: b,
    aTeam: slotTeams[a],
    bTeam: slotTeams[b],
  }));

  // Prepare rows to insert
  let totalInserted = 0;
  const rows: any[] = [];

  // Helper to push a match row
  function pushRow(bracket_round: number, team1_id: string | null, team2_id: string | null) {
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
      is_live: false,
      live_score_team1: null,
      live_score_team2: null,
    });
  }

  // Carry maps for pre-filling later rounds
  // For B=8: Round2 has 2 matches, Round3 has 1
  let semiLeftA: string | null = null;
  let semiLeftB: string | null = null;
  let semiRightA: string | null = null;
  let semiRightB: string | null = null;

  let finalA: string | null = null;
  let finalB: string | null = null;

  if (B === 8) {
    // Round 1 (Quarterfinals = bracket_round 1)
    // r1Pairs order: [0] (1 vs 8), [1] (4 vs 5), [2] (3 vs 6), [3] (2 vs 7)
    // Semis: SF1 from pairs 0 and 1, SF2 from pairs 2 and 3
    r1Pairs.forEach((p, idx) => {
      if (p.aTeam && p.bTeam) {
        pushRow(1, p.aTeam, p.bTeam);
      } else {
        const carry = p.aTeam || p.bTeam; // exactly one present
        if (idx === 0) semiLeftA = carry;
        if (idx === 1) semiLeftB = carry;
        if (idx === 2) semiRightA = carry;
        if (idx === 3) semiRightB = carry;
      }
    });

    // Round 2 (Semifinals = bracket_round 2)
    pushRow(2, semiLeftA, semiLeftB);
    pushRow(2, semiRightA, semiRightB);

    // Round 3 (Final = bracket_round 3)
    pushRow(3, finalA, finalB);

  } else if (B === 4) {
    // Round 1 (Semifinals = bracket_round 1)
    // r1Pairs: [0] (1 vs 4), [1] (2 vs 3)
    r1Pairs.forEach((p, idx) => {
      if (p.aTeam && p.bTeam) {
        pushRow(1, p.aTeam, p.bTeam);
      } else {
        const carry = p.aTeam || p.bTeam;
        // Carry directly to final
        if (idx === 0) finalA = carry;
        if (idx === 1) finalB = carry;
      }
    });

    // Round 2 (Final = bracket_round 2)
    pushRow(2, finalA, finalB);

  } else if (B === 2) {
    // Final only
    const p = r1Pairs[0];
    pushRow(1, p.aTeam, p.bTeam);
  }

  if (rows.length > 0) {
    const { error: insertErr } = await supabase.from('matches').insert(rows);
    if (insertErr) errors.push(`Failed to insert bracket matches: ${insertErr.message}`);
    else totalInserted += rows.length;
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
 * Rebuild bracket if and only if bracket_started=false.
 * Deletes existing bracket matches then calls generateBracket.
 */
export async function rebuildBracket(tournamentId: string): Promise<{ inserted: number; bracketSize: number; rounds: number; errors: string[] }> {

  // Check tournament flags
  const { data: tData, error: tErr } = await supabase
    .from('tournaments')
    .select('id,bracket_started')
    .eq('id', tournamentId)
    .single();

  if (tErr || !tData) {
    return { inserted: 0, bracketSize: 0, rounds: 0, errors: [`Failed to load tournament: ${tErr?.message || 'not found'}`] };
  }

  if ((tData as Tournament).bracket_started) {
    return { inserted: 0, bracketSize: 0, rounds: 0, errors: ['Cannot rebuild: bracket already started.'] };
  }

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