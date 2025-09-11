/**
 * Supabase/PostgreSQL schema types aligned with PRD
 * Tables: tournaments, pools, teams, matches, schedule_templates
 */

export type UUID = string;

export type TournamentStatus =
  | 'draft'
  | 'setup'
  | 'pool_play'
  | 'bracket'
  | 'completed';

export type BracketFormat = 'single_elimination' | 'best_of_3_single_elim';

/**
 * Advancement and game rules are stored as JSONB on tournaments.
 * Define minimal shapes we rely on in the app.
 */
export interface AdvancementRules {
  // Example: [{ fromPoolSize: 4, advanceCount: 2 }]
  pools?: Array<{ fromPoolSize: number; advanceCount: number }>;
  bracketFormat?: BracketFormat;
  tiebreakers?: Array<'head_to_head' | 'set_ratio' | 'point_diff' | 'random'>;
}

export interface GameRules {
  // Example: pool vs bracket caps/targets
  pool?: {
    setTarget?: number; // e.g., 21
    cap?: number;       // e.g., 25
    bestOf?: number;    // e.g., 1 = single set
  };
  bracket?: {
    setTarget?: number;
    cap?: number;
    bestOf?: number; // 1 or 3
  };
}

/**
 * tournaments
 */
export interface Tournament {
  id: UUID;
  name: string;
  date: string; // ISO date (date)
  access_code: string; // unique
  advancement_rules: AdvancementRules | null;
  game_rules: GameRules | null;
  status: TournamentStatus;
  created_at: string; // timestamptz
}

/**
 * pools
 */
export interface Pool {
  id: UUID;
  tournament_id: UUID;
  name: string; // e.g., "Pool A"
  court_assignment: string | null;
}

/**
 * teams
 */
export interface Team {
  id: UUID;
  tournament_id: UUID;
  pool_id: UUID | null; // may be null before pools assigned
  seeded_player_name: string;
  partner_name: string | null;
  full_team_name: string; // "{Seeded Player} + {Partner}" once partner assigned
  seed_in_pool: number | null; // 1,2,3,... within the pool
}

/**
 * matches
 */
export type MatchType = 'pool' | 'bracket';

export interface Match {
  id: UUID;
  tournament_id: UUID;
  pool_id: UUID | null; // null for bracket matches
  round_number: number | null; // pool round number or null for bracket
  team1_id: UUID | null;
  team2_id: UUID | null;
  ref_team_id: UUID | null;
  team1_score: number | null;
  team2_score: number | null;
  winner_id: UUID | null;
  match_type: MatchType;
  bracket_round: number | null; // e.g., R1=1, QF=2, SF=3, F=4 depending on size
  is_live: boolean;
  live_score_team1: number | null;
  live_score_team2: number | null;
}

/**
 * schedule_templates
 * Example template_data:
 * [
 *   { "round": 1, "play": [[1,2]], "ref": [3], "sit": [4] },
 *   { "round": 2, "play": [[1,3]], "ref": [2], "sit": [4] }
 * ]
 */
export interface ScheduleTemplateRound {
  round: number;
  play: number[][]; // array of [seedA, seedB]
  ref?: number[];   // array of seed refs for courts
  sit?: number[];   // optional: seeds sitting out
}

export interface ScheduleTemplate {
  id: UUID;
  tournament_id: UUID;
  pool_size: number;
  template_data: ScheduleTemplateRound[];
}

/**
 * Convenience union for generic record mapping by table name
 */
export interface DB {
  tournaments: Tournament;
  pools: Pool;
  teams: Team;
  matches: Match;
  schedule_templates: ScheduleTemplate;
}