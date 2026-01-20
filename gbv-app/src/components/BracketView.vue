<script setup lang="ts">
import { computed, ref, onMounted, onBeforeUnmount } from 'vue';

type UUID = string;

export interface BracketMatch {
  id: UUID;
  bracket_round: number | null;
  bracket_match_index: number | null;
  team1_id: UUID | null;
  team2_id: UUID | null;
  team1_score?: number | null;
  team2_score?: number | null;
  winner_id?: UUID | null;
  is_live?: boolean | null;
  live_score_team1?: number | null;
  live_score_team2?: number | null;
  live_last_active_at?: string | null;
}

const props = defineProps<{
  matches: BracketMatch[];
  teamNameById: Record<string, string>;
  // Court labels, e.g. ["1","2","3"]. If empty, court assignment shows TBD.
  courts?: string[];
  // Optional: show round titles
  showTitles?: boolean;
}>();

const emit = defineEmits<{
  (e: 'open', matchId: string): void;
}>();

function nameFor(id: string | null): string {
  if (!id) return 'TBD';
  return props.teamNameById[id] || 'TBD';
}

// Group matches by round and sort by bracket_match_index
const grouped = computed(() => {
  const map = new Map<number, BracketMatch[]>();
  for (const m of props.matches) {
    const r = m.bracket_round ?? 1;
    const arr = map.get(r) ?? [];
    arr.push(m);
    map.set(r, arr);
  }
  const rounds = Array.from(map.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([r, arr]) => [
      r,
      arr
        .slice()
        .sort((a, b) => {
          const ai = a.bracket_match_index ?? Number.MAX_SAFE_INTEGER;
          const bi = b.bracket_match_index ?? Number.MAX_SAFE_INTEGER;
          if (ai !== bi) return ai - bi;
          return a.id.localeCompare(b.id);
        }),
    ] as const);
  return rounds;
});

// Derived layout metrics
const roundsCount = computed(() => (grouped.value.length ? grouped.value[grouped.value.length - 1][0] : 0));
const round1Count = computed(() => {
  const r1 = grouped.value.find(([r]) => r === 1);
  return r1 ? r1[1].length : 0;
});

// Layout constants
const TITLE_HEIGHT = 32; // px fixed header height per column
const COL_WIDTH = 270
; // px for each round column
const COL_GAP = 28; // px gap between columns
const TILE_HEIGHT = 68; // px tile height
const TILE_GAP = 20; // base vertical gap between r1 tiles

const TILE_WIDTH = COL_WIDTH;
const CONNECTOR_GAP = 1; // px gap between tile edge and connector so lines don't show under translucent tiles
const bracketWidth = computed(() => {
  const cols = grouped.value.length;
  if (!cols) return 0;
  return cols * COL_WIDTH + (cols - 1) * COL_GAP;
});
const bracketHeight = computed(() => {
  const n = round1Count.value;
  if (n <= 0) return 0;
  return n * TILE_HEIGHT + Math.max(0, n - 1) * TILE_GAP;
});

// Compute center positions for tiles to draw connectors with an overlay SVG
function centerYFor(round: number, index: number): number {
  // Round 1 centers equally spaced at TILE_HEIGHT/2 + i*(TILE_HEIGHT + TILE_GAP)
  // Each subsequent round is centered between the two feeding matches from previous round.
  const base = TILE_HEIGHT / 2;
  const step = TILE_HEIGHT + TILE_GAP;
  // Round 1
  if (round === 1) return base + index * step;

  // Round > 1: parent centers are at indices (2i) and (2i+1) of previous round
  // We can compute directly: average of two r1 centers over 2^(round-1) block.
  // c(round, i) = base + ( (i * 2^(round-1) + (2^(round-1)-1)/2 ) * step )
  const block = 1 << (round - 1); // 2^(round-1)
  const offsetWithinBlock = (block - 1) / 2;
  return base + (iMul(index, block) + offsetWithinBlock) * step;

  function iMul(a: number, b: number): number {
    return a * b;
  }
}

function colStartXFor(round: number): number {
  const colIndex = round - 1;
  return colIndex * (COL_WIDTH + COL_GAP);
}

function tileLeftXFor(round: number): number {
  return colStartXFor(round);
}

function tileRightXFor(round: number): number {
  return colStartXFor(round) + TILE_WIDTH;
}

const LIVE_LEASE_MS = 90 * 1000;
const now = ref<number>(Date.now());
let nowTimer: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  nowTimer = setInterval(() => (now.value = Date.now()), 15_000);
});
onBeforeUnmount(() => {
  if (nowTimer) {
    clearInterval(nowTimer);
    nowTimer = null;
  }
});

function isLiveActive(m: BracketMatch): boolean {
  if (!m.is_live) return false;
  // Treat "live" as a short lease: only show live when an owner exists and heartbeats are recent.
  // This avoids phantom LIVE when a session wasn't properly released.
  if (!m.live_last_active_at) return false;
  const ts = m.live_last_active_at ?? null;
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) return false;
  return (now.value - t) <= LIVE_LEASE_MS;
}

// Helpers to detect BYE in Round 1
function isRound1Bye(m: BracketMatch): boolean {
  if ((m.bracket_round ?? 1) !== 1) return false;
  const a = !!m.team1_id;
  const b = !!m.team2_id;
  return (a && !b) || (!a && b);
}

function isDisabled(m: BracketMatch): boolean {
  return isRound1Bye(m);
}

function byeAdvancingTeamId(m: BracketMatch): string | null {
  if (!isRound1Bye(m)) return null;
  return (m.team1_id ?? m.team2_id) ?? null;
}

function byeAdvancesText(m: BracketMatch): string | null {
  if (!isRound1Bye(m)) return null;
  return 'bye-advances';
}

function winnerIdFor(m: BracketMatch): string | null {
  const winId = m.winner_id ?? null;
  const t1 = m.team1_id ?? null;
  const t2 = m.team2_id ?? null;
  if (winId && (winId === t1 || winId === t2)) return winId;
  if (t1 && t2 && isCompleted(m)) {
    const s1 = m.team1_score ?? 0;
    const s2 = m.team2_score ?? 0;
    if (s1 === s2) return null;
    return s1 > s2 ? t1 : t2;
  }
  return null;
}

function winnerSide(m: BracketMatch): 1 | 2 | null {
  const winId = winnerIdFor(m);
  if (!winId) return null;
  if (m.team1_id && winId === m.team1_id) return 1;
  if (m.team2_id && winId === m.team2_id) return 2;
  return null;
}

function loserTeamId(m: BracketMatch): string | null {
  const winId = winnerIdFor(m);
  if (!winId) return null;
  const t1 = m.team1_id ?? null;
  const t2 = m.team2_id ?? null;
  if (!t1 || !t2) return null;
  if (winId === t1) return t2;
  if (winId === t2) return t1;
  return null;
}

function isCompleted(m: BracketMatch): boolean {
  return m.team1_score != null && m.team2_score != null;
}

function winnerPillText(m: BracketMatch, side: 1 | 2): string {
  if (!isCompleted(m)) return 'WIN';
  const s1 = m.team1_score ?? 0;
  const s2 = m.team2_score ?? 0;
  const a = side === 1 ? s1 : s2;
  const b = side === 1 ? s2 : s1;
  return `WIN ${a}-${b}`;
}

function roundTitle(round: number): string {
  const mr = roundsCount.value;
  if (mr <= 1) return 'Final';
  if (mr === 2) return round === 1 ? 'Semifinals' : 'Final';
  if (mr === 3) return round === 1 ? 'Quarterfinals' : round === 2 ? 'Semifinals' : 'Final';
  return `Round ${round}`;
}

const courtsSorted = computed(() => {
  const raw = (props.courts ?? []).map((c) => (c ?? '').trim()).filter(Boolean);
  const uniq = Array.from(new Set(raw));
  uniq.sort((a, b) => {
    const na = Number(a);
    const nb = Number(b);
    const aNum = Number.isFinite(na);
    const bNum = Number.isFinite(nb);
    if (aNum && bNum) return na - nb;
    if (aNum && !bNum) return -1;
    if (!aNum && bNum) return 1;
    return a.localeCompare(b);
  });
  return uniq;
});

type DerivedMeta = { court: string | null; refTeamId: string | null };
const metaByMatchId = computed<Record<string, DerivedMeta>>(() => {
  const meta: Record<string, DerivedMeta> = {};

  const courts = courtsSorted.value;
  const hasCourts = courts.length > 0;

  const matchesByKey = new Map<string, BracketMatch>();
  for (const m of props.matches) {
    if (m.bracket_round == null || m.bracket_match_index == null) continue;
    matchesByKey.set(`${m.bracket_round}:${m.bracket_match_index}`, m);
  }

  // schedule order: round asc then index asc
  const ordered = props.matches
    .filter((m) => m.bracket_round != null && m.bracket_match_index != null)
    .slice()
    .sort((a, b) => {
      const ar = a.bracket_round ?? 0;
      const br = b.bracket_round ?? 0;
      if (ar !== br) return ar - br;
      const ai = a.bracket_match_index ?? 0;
      const bi = b.bracket_match_index ?? 0;
      if (ai !== bi) return ai - bi;
      return a.id.localeCompare(b.id);
    });

  // Court assignment per round: use courts from lowest to highest, wrap.
  const courtIndexById = new Map<string, number>();
  if (hasCourts) {
    const byRound = new Map<number, BracketMatch[]>();
    for (const m of ordered) {
      const r = m.bracket_round ?? 1;
      const arr = byRound.get(r) ?? [];
      arr.push(m);
      byRound.set(r, arr);
    }
    for (const [_r, arr] of byRound.entries()) {
      arr.sort((a, b) => (a.bracket_match_index ?? 0) - (b.bracket_match_index ?? 0));
      for (let i = 0; i < arr.length; i++) {
        courtIndexById.set(arr[i].id, i % courts.length);
      }
    }
  }

  // Ref assignment: loser of the previous played game refs the next played game (global schedule order),
  // with a special-case for Round 1 play-ins (the already-advanced BYE opponent refs the play-in).
  let lastPlayedMatchGlobal: BracketMatch | null = null;

  for (const m of ordered) {
    const courtIndex = hasCourts ? (courtIndexById.get(m.id) ?? 0) : null;
    const court = hasCourts && courtIndex != null ? courts[courtIndex] : null;
    let refTeamId: string | null = null;

    // Skip referee assignment for BYE-only matches (no game played)
    if (!isRound1Bye(m)) {
      // Special case (highest priority): Round 1 play-in with a BYE opponent already placed in next match.
      // The already-advanced team refs the play-in game.
      if ((m.bracket_round ?? 1) === 1) {
        const t1 = m.team1_id ?? null;
        const t2 = m.team2_id ?? null;
        const isPlayIn = !!t1 && !!t2;
        if (isPlayIn) {
          const nextIndex = Math.floor((m.bracket_match_index ?? 0) / 2);
          const sideWinnerGoesTo = ((m.bracket_match_index ?? 0) % 2 === 0) ? 'team1_id' : 'team2_id';
          const next = matchesByKey.get(`2:${nextIndex}`) ?? null;
          if (next) {
            const opponent = sideWinnerGoesTo === 'team1_id' ? (next.team2_id ?? null) : (next.team1_id ?? null);
            if (opponent) refTeamId = opponent;
          }
        }
      }

      // Default: loser of the previous played game in overall schedule order.
      if (!refTeamId && lastPlayedMatchGlobal) {
        refTeamId = loserTeamId(lastPlayedMatchGlobal);
      }
    }

    meta[m.id] = { court, refTeamId };

    if (!isRound1Bye(m)) {
      lastPlayedMatchGlobal = m;
    }
  }

  return meta;
});

function courtLabelFor(m: BracketMatch): string {
  const court = metaByMatchId.value[m.id]?.court ?? null;
  return court ? `Court ${court}` : 'Court TBD';
}

function refLabelFor(m: BracketMatch): string {
  if (isRound1Bye(m)) return 'Ref: —';
  const refTeamId = metaByMatchId.value[m.id]?.refTeamId ?? null;
  return `Ref: ${nameFor(refTeamId)}`;
}

function onOpen(m: BracketMatch) {
  if (isDisabled(m)) return;
  emit('open', m.id);
}
</script>

<template>
  <div class="bracket-scroll" v-if="grouped.length">
    <div class="bracket-root" :style="{ minWidth: bracketWidth + 'px' }">
      <!-- Titles row (separate from connector coordinate space) -->
      <div v-if="showTitles !== false" class="bracket-head" :style="{ height: TITLE_HEIGHT + 'px' }">
        <div
          v-for="[r] in grouped"
          :key="r + '-title'"
          class="col-title"
          :style="{
            width: COL_WIDTH + 'px',
            marginRight: (r < roundsCount ? COL_GAP : 0) + 'px'
          }"
        >
          {{ roundTitle(r) }}
        </div>
      </div>

      <!-- Stage is the coordinate origin for tiles + SVG connectors -->
      <div class="bracket-stage" :style="{ height: bracketHeight + 'px' }">
        <!-- Columns -->
        <div
          v-for="[r, arr] in grouped"
          :key="r"
          class="bracket-col"
          :style="{
            width: COL_WIDTH + 'px',
            marginRight: (r < roundsCount ? COL_GAP : 0) + 'px'
          }"
        >
          <div class="col-body" :style="{ position: 'relative', height: bracketHeight + 'px' }">
            <div
              v-for="m in arr"
              :key="m.id"
              class="match-tile"
              :class="{
                'match-tile--disabled': isDisabled(m),
                'match-tile--done': !!winnerSide(m),
                'match-tile--live': isLiveActive(m)
              }"
              :style="{
                position: 'absolute',
                left: '0px',
                top: (centerYFor(r, m.bracket_match_index ?? 0) - TILE_HEIGHT / 2) + 'px',
                height: TILE_HEIGHT + 'px',
                width: TILE_WIDTH + 'px'
              }"
              @click="onOpen(m)"
            >
              <!-- BYE match: show advancing team on row 1, "bye-advances" on row 2 (no extra BYE text) -->
              <template v-if="isRound1Bye(m)">
                <div class="tile-row" :class="{ 'tile-row--winner': !!winnerSide(m) }">
                  <div class="team-name">{{ nameFor(byeAdvancingTeamId(m)) }}</div>
                  <span class="pill pill-bye">BYE</span>
                </div>
                <div class="tile-subrow">{{ byeAdvancesText(m) }}</div>
              </template>

              <template v-else>
                <div class="tile-row" :class="{ 'tile-row--winner': winnerSide(m) === 1, 'tile-row--loser': !!winnerSide(m) && winnerSide(m) !== 1 }">
                  <div class="team-name" :class="{ 'team-name--loser': !!winnerSide(m) && winnerSide(m) !== 1 }">{{ nameFor(m.team1_id) }}</div>
                  <span class="pill pill-winner" v-if="winnerSide(m) === 1">{{ winnerPillText(m, 1) }}</span>
                </div>

                <div class="tile-row" :class="{ 'tile-row--winner': winnerSide(m) === 2, 'tile-row--loser': !!winnerSide(m) && winnerSide(m) !== 2 }">
                  <div class="team-name" :class="{ 'team-name--loser': !!winnerSide(m) && winnerSide(m) !== 2 }">{{ nameFor(m.team2_id) }}</div>
                  <span class="pill pill-winner" v-if="winnerSide(m) === 2">{{ winnerPillText(m, 2) }}</span>
                </div>

                <div class="tile-meta">
                  <span class="tile-meta-left">{{ courtLabelFor(m) }} • {{ refLabelFor(m) }}</span>
                  <span v-if="isLiveActive(m)" class="live-pill">
                    LIVE <span class="tabular-nums">{{ m.live_score_team1 ?? 0 }}-{{ m.live_score_team2 ?? 0 }}</span>
                  </span>
                </div>
              </template>
            </div>
          </div>
        </div>

        <!-- Connectors overlay (SVG) -->
        <svg class="connectors" :width="bracketWidth" :height="bracketHeight">
          <template v-for="[r, arr] in grouped">
            <template v-if="r < roundsCount">
              <path
                v-for="m in arr"
                :key="m.id + '-conn'"
                :d="(() => {
                  const index = m.bracket_match_index ?? 0;
                  const x1 = tileRightXFor(r) + CONNECTOR_GAP;
                  const y1 = centerYFor(r, index);
                  const rawX2 = tileLeftXFor(r + 1) - CONNECTOR_GAP;
                  const x2 = Math.max(rawX2, x1);
                  const y2 = centerYFor(r + 1, Math.floor(index / 2));
                  const mx = x1 + (x2 - x1) / 2;
                  return `M ${x1} ${y1} H ${mx} V ${y2} H ${x2}`;
                })()"
                class="connector"
              />
            </template>
          </template>
        </svg>
      </div>
    </div>
  </div>
</template>

<style scoped>
.bracket-scroll {
  width: 100%;
  overflow-x: auto;
  overflow-y: hidden;
  padding-bottom: 8px;
}

.bracket-root {
  position: relative;
  isolation: isolate;
}

.bracket-head {
  display: flex;
  align-items: flex-end;
}

.bracket-stage {
  position: relative;
  display: flex;
  align-items: flex-start;
}

/* Columns */
.bracket-col {
  display: flex;
  flex-direction: column;
}

.col-title {
  color: rgba(255,255,255,0.8);
  font-size: 0.9rem;
  font-weight: 600;
  padding: 0 4px 10px 4px;
}

.col-body {
  padding-left: 0;
}

.match-tile {
  cursor: pointer;
  border-radius: 16px;
  background: rgba(255,255,255,0.10);
  border: 1px solid rgba(255,255,255,0.18);
  padding: 4px 8px;
  color: white;
  transition: background 0.15s ease-in-out, border-color 0.15s ease-in-out, transform 0.15s ease-in-out;
  backdrop-filter: blur(10px);
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 1px;
  z-index: 10;
}

.match-tile:hover {
  background: rgba(255,255,255,0.14);
  border-color: rgba(255,255,255,0.28);
  transform: translateY(-1px);
}

.match-tile--disabled {
  cursor: default;
  opacity: 0.85;
}

.match-tile--disabled:hover {
  background: rgba(255,255,255,0.10);
  border-color: rgba(255,255,255,0.18);
  transform: none;
}

.match-tile--done {
  border-color: rgba(250,204,21,0.65);
  box-shadow: 0 0 0 1px rgba(250,204,21,0.20);
}

.match-tile--done:hover {
  border-color: rgba(250,204,21,0.85);
}

.match-tile--live {
  border-color: rgba(220,38,38,0.85);
  box-shadow: 0 0 0 1px rgba(220,38,38,0.22);
}

.match-tile--live:hover {
  border-color: rgba(220,38,38,0.95);
}

.tile-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  min-width: 0;
  line-height: 1.05;
  border-radius: 12px;
  padding: 2px 6px;
}

.tile-row--winner {
  background: rgba(34,197,94,0.12);
}

.tile-row--winner .team-name {
  font-weight: 800;
}

.tile-row--loser {
  opacity: 0.70;
}

.team-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.83rem;
  font-weight: 650;
  padding-top: 1px; /* optical centering in compact rows */
}

.team-name--loser {
  text-decoration: line-through;
  text-decoration-thickness: 2px;
  text-decoration-color: rgba(255,255,255,0.65);
}

.tile-subrow {
  display: flex;
  align-items: center;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.75rem;
  font-weight: 750;
  letter-spacing: 0.02em;
  text-transform: lowercase;
  color: rgba(255,255,255,0.80);
  padding: 2px 6px;
}

.tile-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
  font-size: 0.72rem;
  font-weight: 650;
  color: rgba(255,255,255,0.72);
  padding: 1px 6px 2px 6px;
}

.tile-meta-left {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.live-pill {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border-radius: 999px;
  background: rgba(220,38,38,0.92);
  color: white;
  padding: 2px 8px;
  font-size: 0.65rem;
  font-weight: 800;
  letter-spacing: 0.02em;
  text-transform: uppercase;
}

.pill {
  display: inline-flex;
  align-items: center;
  padding: 2px 7px;
  border-radius: 999px;
  font-size: 0.65rem;
  font-weight: 800;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  user-select: none;
}

.pill-winner {
  color: rgba(15,23,42,0.95);
  background: rgba(250,204,21,0.92);
  border: 1px solid rgba(250,204,21,0.85);
}

.pill-bye {
  color: rgba(255,255,255,0.95);
  background: rgba(59,130,246,0.92);
  border: 1px solid rgba(59,130,246,0.85);
}

/* SVG overlay */
.connectors {
  position: absolute;
  left: 0;
  top: 0;
  pointer-events: none;
  z-index: 1;
}

.connector {
  fill: none;
  stroke: rgba(255,255,255,0.85);
  stroke-width: 2.0;
  stroke-linecap: round;
  stroke-linejoin: round;
  vector-effect: non-scaling-stroke;
}
</style>
