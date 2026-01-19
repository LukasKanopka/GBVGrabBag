<script setup lang="ts">
import { computed } from 'vue';

type UUID = string;

export interface BracketMatch {
  id: UUID;
  bracket_round: number | null;
  bracket_match_index: number | null;
  team1_id: UUID | null;
  team2_id: UUID | null;
  winner_id?: UUID | null;
  is_live?: boolean | null;
}

const props = defineProps<{
  matches: BracketMatch[];
  teamNameById: Record<string, string>;
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
const COL_WIDTH = 230; // px for each round column
const COL_GAP = 28; // px gap between columns
const TILE_HEIGHT = 54; // px tile height
const TILE_GAP = 20; // base vertical gap between r1 tiles

const TILE_WIDTH = COL_WIDTH;
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

function winnerSide(m: BracketMatch): 1 | 2 | null {
  const winId = m.winner_id ?? null;
  if (!winId) return null;
  if (m.team1_id && winId === m.team1_id) return 1;
  if (m.team2_id && winId === m.team2_id) return 2;
  return null;
}

function roundTitle(round: number): string {
  const mr = roundsCount.value;
  if (mr <= 1) return 'Final';
  if (mr === 2) return round === 1 ? 'Semifinals' : 'Final';
  if (mr === 3) return round === 1 ? 'Quarterfinals' : round === 2 ? 'Semifinals' : 'Final';
  return `Round ${round}`;
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
                'match-tile--live': !!m.is_live
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
                  <span class="pill pill-winner" v-if="!!winnerSide(m)">WIN</span>
                </div>
                <div class="tile-subrow">{{ byeAdvancesText(m) }}</div>
              </template>

              <template v-else>
                <div class="tile-row" :class="{ 'tile-row--winner': winnerSide(m) === 1, 'tile-row--loser': !!winnerSide(m) && winnerSide(m) !== 1 }">
                  <div class="team-name">{{ nameFor(m.team1_id) }}</div>
                  <span class="pill pill-winner" v-if="winnerSide(m) === 1">WIN</span>
                </div>

                <div class="tile-row" :class="{ 'tile-row--winner': winnerSide(m) === 2, 'tile-row--loser': !!winnerSide(m) && winnerSide(m) !== 2 }">
                  <div class="team-name">{{ nameFor(m.team2_id) }}</div>
                  <span class="pill pill-winner" v-if="winnerSide(m) === 2">WIN</span>
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
                  const x1 = tileRightXFor(r) - 10;
                  const y1 = centerYFor(r, index);
                  const x2 = tileLeftXFor(r + 1) + 10;
                  const y2 = centerYFor(r + 1, Math.floor(index / 2));
                  const mx = x1 + (COL_GAP / 2);
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
  padding: 8px 10px;
  color: white;
  transition: background 0.15s ease-in-out, border-color 0.15s ease-in-out, transform 0.15s ease-in-out;
  backdrop-filter: blur(10px);
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 4px;
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
  border-color: rgba(34,197,94,0.35);
}

.match-tile--live {
  border-color: rgba(248,113,113,0.45);
}

.tile-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  line-height: 1.15;
  border-radius: 12px;
  padding: 4px 6px;
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
  font-size: 0.85rem;
  font-weight: 650;
  padding-top: 1px; /* optical centering in compact rows */
}

.tile-subrow {
  font-size: 0.75rem;
  font-weight: 750;
  letter-spacing: 0.02em;
  text-transform: lowercase;
  color: rgba(255,255,255,0.80);
  padding: 3px 6px;
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
