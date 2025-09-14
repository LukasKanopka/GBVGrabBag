# Gator Beach Volleyball Tournament App — Current Status and Implementation Plan

Source of truth: Product Requirements at [PRD.md](PRD.md)

## Snapshot Summary

### Completed
- Database schema foundations including tournaments, pools, teams, matches, schedule_templates in [supabase/schema.sql](supabase/schema.sql)
- Schedule template management UI in [src/pages/AdminScheduleTemplates.vue](src/pages/AdminScheduleTemplates.vue)
- Pool schedule generation and prerequisites checks implemented in [checkPrerequisites()](src/lib/schedule.ts:36) and [generateSchedule()](src/lib/schedule.ts:76)
- Public tournament hub in [src/pages/TournamentPublic.vue](src/pages/TournamentPublic.vue)
- Live scoreboard with realtime updates in [src/pages/LiveScoreboard.vue](src/pages/LiveScoreboard.vue)
- Score entry for completed matches in [src/pages/ScoreEntry.vue](src/pages/ScoreEntry.vue)
- Admin authentication guard in [src/router/index.ts](src/router/index.ts)
- Admin tournament setup CRUD in [src/pages/AdminTournamentSetup.vue](src/pages/AdminTournamentSetup.vue) with routes wired in [src/router/index.ts](src/router/index.ts)
- Bracket lifecycle fields added: bracket_started and bracket_generated_at in [supabase/schema.sql](supabase/schema.sql) and types in [src/types/db.ts](src/types/db.ts)
- Players Import UI implemented and linked via [src/pages/AdminPlayersImport.vue](src/pages/AdminPlayersImport.vue) and routed in [src/router/index.ts](src/router/index.ts)
- Pools & Seeds UI implemented and linked via [src/pages/AdminPoolsSeeds.vue](src/pages/AdminPoolsSeeds.vue) and routed in [src/router/index.ts](src/router/index.ts)
- Partner Assignment implemented and linked via [src/pages/AdminPartnerAssignment.vue](src/pages/AdminPartnerAssignment.vue) and routed in [src/router/index.ts](src/router/index.ts)
- Generate Schedule UI implemented and linked via [src/pages/AdminGenerateSchedule.vue](src/pages/AdminGenerateSchedule.vue) and routed in [src/router/index.ts](src/router/index.ts)

### In Progress
- Planning and tracking document (this file)

### Pending (MVP-critical)
- Public Pools pages for Matches and Standings with tiebreakers
- Bracket Engine (auto seed, single_elimination and best_of_3_single_elim finals) and Admin Bracket UI
- Dashboard status badges and checks
- Documentation updates and sample CSV
- Optional unit tests for generation and seeding

## MVP Decisions and Assumptions
- Players CSV: single column with header seeded_player_name, UTF-8
- Pool sizes supported for templates/generation: 4, 5
- Bracket formats: single_elimination and best_of_3_single_elim (finals)
- Tiebreakers priority: head_to_head, set_ratio, point_diff, random

## Roadmap and Acceptance Criteria

### Phase B — Admin Foundations
1. Players Import (AdminPlayersImport.vue)
   - Build CSV upload using Papaparse; preview table with de-duplication (case-insensitive)
   - Bulk insert: teams rows with seeded_player_name and full_team_name = seeded_player_name; partner_name null; pool_id null; seed_in_pool null
   - Manual add/remove/edit row UI
   - Acceptance: Duplicates prevented; invalid CSV errors shown; rows persist to DB

2. Pools and Seeds (AdminPoolsSeeds.vue)
   - Pools CRUD: name, court_assignment stored in [pools](supabase/schema.sql)
   - Drag and drop teams into pools; assign seed_in_pool with per-pool uniqueness (enforced by teams_pool_seed_uidx)
   - Visual validation for missing or duplicate seeds
   - Acceptance: Pool assignment and seeds persist; no seed conflicts; UX reflects errors

3. Partner Assignment (AdminPartnerAssignment.vue)
   - Mobile-first list of seeded players; tap to enter partner_name
   - Auto update full_team_name as Seeded + Partner
   - Completeness indicator and filter for “missing partner”
   - Acceptance: Partner names persist; team names update; completeness turns 100 percent when all set

### Phase C — Pool Play UX
4. Generate Schedule UI (AdminGenerateSchedule.vue or dashboard card)
   - Button triggers [checkPrerequisites()](src/lib/schedule.ts:36); if ok calls [generateSchedule()](src/lib/schedule.ts:76)
   - Disable until prerequisites met; surface missing templates per pool size and missing partners
   - Guard against duplicates: if pool matches exist, prompt to confirm overwrite or block
   - Acceptance: Matches inserted per templates; errors clear; no accidental duplicates

5. Public Nested Pool Play UX
   - Landing after access: if [Tournament.status](src/types/db.ts:52) = pool_play => show Pools list; if = bracket => show Bracket
   - Pools list page links to Pool details
   - Pool details: standings on top computed per [AdvancementRules](src/types/db.ts) tiebreakers; schedule below ordered by round_number; display ref team and red LIVE marker when [Match.is_live](src/types/db.ts:99) is true
   - Match actions: after tapping a match, present two options:
     - Live Score Recording with Scoreboard (disabled when is_live true)
     - Enter Score Manually (always available)
   - Acceptance: Users navigate via Pools -> Pool -> Match -> Action; standings update reactively on score changes; live marker visible and exclusive live scoring enforced by is_live flag.

6. Post-bracket edit warning
   - In [submitScore()](src/pages/ScoreEntry.vue:82) show non-blocking toast when bracket exists or status is bracket
   - Acceptance: Warning appears under condition; no scoring block

### Phase D — Bracket Play
7. Bracket Engine (src/lib/bracket.ts)
   - computePoolStandings(tournamentId)
   - seedAdvancers(advancementRules, standings) for pool sizes 4, 5
   - generateBracket(tournamentId): create matches with match_type bracket, bracket_round; set tournaments.bracket_started true and bracket_generated_at, status bracket
   - rebuildBracket(tournamentId): allowed only when bracket_started false; else block with message
   - Support final series best_of_3 by creating multiple final matches and resolving series winner
   - Acceptance: Correct number of bracket matches; seeding correct; guard enforced

8. Admin Bracket (AdminBracket.vue)
   - Generate, Rebuild, Manual Mode toggle
   - Manual slot editing for team1_id and team2_id per bracket match
   - Acceptance: Actions persist; visual bracket list accurate

### Phase E — Polish and Docs
9. Dashboard Checks and Badges
   - Templates coverage for pool sizes in use
   - Partners completeness
   - Seeding completeness (no null seeds when pooled)
   - Pool schedule generated status
   - Bracket status and generated time
   - Acceptance: All badges reflect live DB state

10. Documentation and Samples
   - README: setup, Supabase env, RLS notes, sample CSV
   - Acceptance: A new dev can set up and run MVP following README only

11. Unit Tests (optional but recommended)
   - schedule mapping from templates
   - tiebreaker scenarios for standings
   - Acceptance: tests pass locally in CI or dev env

## Roles and Access
- Admin-only pages: protected by router meta requiresAdmin in [src/router/index.ts](src/router/index.ts)
- Public: score entry and live scoreboard require ensureAnon session in [src/stores/session.ts](src/stores/session.ts)

## Risks and Mitigations
- RLS Write Access: score and admin writes depend on authenticated role; ensure [ensureAnon()](src/stores/session.ts:54) runs before write flows
- Duplicate Generation: mitigate with explicit overwrite confirmation; consider a generation marker
- Tiebreaker Edge Cases: test head_to_head triangles and set_ratio ties; include fallback to random as last resort
- Bracket Best-of-3 Finals: clearly represent series in UI; optionally group final matches by series id

## Open Questions (tracked)
- Do we need per-court scheduling preferences or constraints beyond templates for MVP
- Should manual bracket mode allow creating byes explicitly or auto-place by default

## Useful Links
- Public Tournament: [src/pages/TournamentPublic.vue](src/pages/TournamentPublic.vue)
- Score Entry: [src/pages/ScoreEntry.vue](src/pages/ScoreEntry.vue)
- Live Scoreboard: [src/pages/LiveScoreboard.vue](src/pages/LiveScoreboard.vue)
- Admin Dashboard: [src/pages/AdminDashboard.vue](src/pages/AdminDashboard.vue)
- Admin Tournament Setup: [src/pages/AdminTournamentSetup.vue](src/pages/AdminTournamentSetup.vue)
- Admin Schedule Templates: [src/pages/AdminScheduleTemplates.vue](src/pages/AdminScheduleTemplates.vue)
- Router: [src/router/index.ts](src/router/index.ts)
- DB Schema: [supabase/schema.sql](supabase/schema.sql)
- Schedule Generator: [generateSchedule()](src/lib/schedule.ts:76)

## Execution Checklist (live)
- [x] AdminPlayersImport.vue implemented and linked
- [x] AdminPoolsSeeds.vue implemented and linked
- [x] AdminPartnerAssignment.vue implemented and linked
- [x] Generate Schedule UI wired and guarded
- [ ] Public Pools: Matches list and Standings ready
- [ ] Bracket engine implemented with AdminBracket.vue
- [ ] Dashboard badges reflect status
- [ ] README updated with CSV sample and setup

## Mermaid — End to End Flow

```mermaid
flowchart TD
  A[Admin imports players] --> B[Assign pools and seeds]
  B --> C[Partner assignment]
  C --> D{Prereqs ok templates + partners}
  D -- yes --> E[Generate pool schedule]
  E --> F[Players enter scores]
  F --> G[Compute standings]
  G --> H{Admin generate bracket]
  H -- auto --> I[Create bracket matches]
  I --> J[Bracket play]
  H -- manual --> K[Manual bracket mode]
  K --> J
```

## Mermaid — Public Nested Flow

```mermaid
flowchart TD
  A[Enter access code] --> B{Tournament status}
  B -- pool_play --> C[Pools list]
  C --> D[Pool details: standings top]
  D --> E[Schedule below]
  E --> F[Tap match]
  F --> G[Choose action]
  G --> H[Live scoreboard]
  G --> I[Enter score manually]
  B -- bracket --> J[Bracket view]
```

## Notes
- This document is updated as tasks complete; see Execution Checklist for real-time progress
- Files and functions linked above are authoritative locations for implementation