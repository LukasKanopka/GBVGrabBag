<script setup lang="ts">
import { computed } from 'vue';

type UUID = string;

export interface BracketMatch {
  id: UUID;
  bracket_round: number | null;
  bracket_match_index: number | null;
  team1_id: UUID | null;
  team2_id: UUID | null;
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
const bracketSize = computed(() => Math.max(2, round1Count.value * 2));

// Layout constants
const COL_WIDTH = 260; // px for each round column
const COL_GAP = 32; // px gap between columns
const TILE_HEIGHT = 56; // px tile height
const TILE_GAP = 24; // base vertical gap between r1 tiles

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

function centerXFor(round: number): number {
  // Column index is round-1
  const colIndex = round - 1;
  return colIndex * (COL_WIDTH + COL_GAP) + COL_WIDTH; // right side center of the tile area in the column
}

// Helpers to detect BYE in Round 1
function isRound1Bye(m: BracketMatch): boolean {
  if ((m.bracket_round ?? 1) !== 1) return false;
  const a = !!m.team1_id;
  const b = !!m.team2_id;
  return (a && !b) || (!a && b);
}

function byeLabelFor(m: BracketMatch, side: 1 | 2): string | null {
  if (!isRound1Bye(m)) return null;
  const a = !!m.team1_id;
  const b = !!m.team2_id;
  if (side === 1 && !a && b) return 'BYE';
  if (side === 2 && !b && a) return 'BYE';
  return null;
}

function roundTitle(round: number): string {
  const mr = roundsCount.value;
  if (mr <= 1) return 'Final';
  if (mr === 2) return round === 1 ? 'Semifinals' : 'Final';
  if (mr === 3) return round === 1 ? 'Quarterfinals' : round === 2 ? 'Semifinals' : 'Final';
  return `Round ${round}`;
}

function onOpen(id: string) {
  emit('open', id);
}
</script>

<template>
  <div class="bracket-root">
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
      <div v-if="showTitles !== false" class="col-title">{{ roundTitle(r) }}</div>

      <div class="col-body" :style="{ position: 'relative', height: (round1Count * (TILE_HEIGHT + TILE_GAP)) + 'px' }">
        <div
          v-for="m in arr"
          :key="m.id"
          class="match-tile"
          :style="{
            position: 'absolute',
            top: (centerYFor(r, m.bracket_match_index ?? 0) - TILE_HEIGHT / 2) + 'px',
            height: TILE_HEIGHT + 'px',
            width: (COL_WIDTH - 8) + 'px'
          }"
          @click="onOpen(m.id)"
        >
          <div class="tile-row">
            <div class="team-name">
              <span class="bye" v-if="byeLabelFor(m, 1)">{{ byeLabelFor(m, 1) }}</span>
              <span v-else>{{ nameFor(m.team1_id) }}</span>
            </div>
          </div>
          <div class="tile-row">
            <div class="team-name">
              <span class="bye" v-if="byeLabelFor(m, 2)">{{ byeLabelFor(m, 2) }}</span>
              <span v-else>{{ nameFor(m.team2_id) }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Connectors overlay (SVG) -->
    <svg
      class="connectors"
      :width="(grouped.length * COL_WIDTH) + ((grouped.length - 1) * COL_GAP)"
      :height="(round1Count * (TILE_HEIGHT + TILE_GAP))"
    >
      <template v-for="[r, arr] in grouped">
        <template v-if="r < roundsCount">
          <line
            v-for="m in arr"
            :key="m.id + '-conn'"
            :x1="centerXFor(r)"
            :y1="centerYFor(r, m.bracket_match_index ?? 0)"
            :x2="centerXFor(r + 1) - COL_WIDTH"
            :y2="centerYFor(r + 1, Math.floor((m.bracket_match_index ?? 0) / 2))"
            stroke="rgba(255,255,255,0.45)"
            stroke-width="2"
          />
          <!-- small horizontal cap into next tile -->
          <line
            v-for="m in arr"
            :key="m.id + '-cap'"
            :x1="centerXFor(r + 1) - COL_WIDTH"
            :y1="centerYFor(r + 1, Math.floor((m.bracket_match_index ?? 0) / 2))"
            :x2="centerXFor(r + 1) - (COL_WIDTH - 12)"
            :y2="centerYFor(r + 1, Math.floor((m.bracket_match_index ?? 0) / 2))"
            stroke="rgba(255,255,255,0.45)"
            stroke-width="2"
          />
        </template>
      </template>
    </svg>
  </div>
</template>

<style scoped>
.bracket-root {
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
  padding: 6px 4px 10px 4px;
}

.col-body {
  border-left: 1px solid rgba(255,255,255,0.25);
  padding-left: 8px;
}

.match-tile {
  cursor: pointer;
  border-radius: 12px;
  background: rgba(255,255,255,0.10);
  border: 1px solid rgba(255,255,255,0.20);
  padding: 8px 10px;
  color: white;
  transition: background 0.15s ease-in-out;
}

.match-tile:hover {
  background: rgba(255,255,255,0.15);
}

.tile-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  line-height: 1.1;
}

.team-name {
  font-size: 0.9rem;
  font-weight: 600;
}

.bye {
  display: inline-block;
  padding: 2px 6px;
  border-radius: 8px;
  font-size: 0.75rem;
  font-weight: 700;
  color: #0f172a;
  background: #fde68a; /* amber-200 */
}

/* SVG overlay */
.connectors {
  position: absolute;
  left: 0;
  top: calc(1.5rem + 6px); /* roughly align with first column top; minor visual offset ok */
  pointer-events: none;
}
</style>