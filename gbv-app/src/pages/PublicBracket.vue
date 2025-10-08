<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useSessionStore } from '../stores/session';
import { useToast } from 'primevue/usetoast';
import supabase from '../lib/supabase';
import PublicLayout from '../components/layout/PublicLayout.vue';
import Bracket from 'vue-tournament-bracket';

type UUID = string;

type Team = { id: UUID; full_team_name: string };

type Match = {
  id: UUID;
  tournament_id: UUID;
  pool_id: UUID | null;
  round_number: number | null;
  team1_id: UUID | null;
  team2_id: UUID | null;
  is_live: boolean;
  live_score_team1: number | null;
  live_score_team2: number | null;
  winner_id: UUID | null;
  match_type: 'pool' | 'bracket';
  bracket_round: number | null;
  bracket_match_index: number | null;
};

const route = useRoute();
const router = useRouter();
const session = useSessionStore();
const toast = useToast();

const accessCode = computed(() => (route.params.accessCode as string) ?? session.accessCode ?? '');
const loading = ref(false);

const matches = ref<Match[]>([]);
const teamNameById = ref<Record<string, string>>({});

const maxRound = computed(() => Math.max(0, ...matches.value.map(m => m.bracket_round || 0)));

function roundTitle(r: number) {
  const mr = maxRound.value;
  if (mr <= 1) return 'Final';
  if (mr === 2) return r === 1 ? 'Semifinals' : 'Final';
  if (mr === 3) return r === 1 ? 'Quarterfinals' : r === 2 ? 'Semifinals' : 'Final';
  // Fallback
  return `Round ${r}`;
}

function nameFor(id: string | null) {
  if (!id) return 'TBD';
  return teamNameById.value[id] || 'TBD';
}

function groupedByRound() {
  const map = new Map<number, Match[]>();
  for (const m of matches.value) {
    const r = m.bracket_round || 1;
    const arr = map.get(r) ?? [];
    arr.push(m);
    map.set(r, arr);
  }
  // sort each round by bracket_match_index for proper visual order
  const entries = Array.from(map.entries()).sort((a, b) => a[0] - b[0]);
  return entries.map(([r, arr]) => [
    r,
    arr.sort((a, b) => {
      const ai = (a.bracket_match_index ?? Number.MAX_SAFE_INTEGER);
      const bi = (b.bracket_match_index ?? Number.MAX_SAFE_INTEGER);
      if (ai !== bi) return ai - bi;
      return a.id.localeCompare(b.id);
    })
  ] as const);
}

const bracketData = computed(() => {
  // group by round
  const byRound = new Map<number, Match[]>();
  for (const m of matches.value) {
    const r = m.bracket_round || 1;
    const arr = byRound.get(r) ?? [];
    arr.push(m);
    byRound.set(r, arr);
  }

  const roundsSorted = Array.from(byRound.entries()).sort((a, b) => a[0] - b[0]);

  return roundsSorted.map(([r, arr]) => {
    const games = arr
      .slice()
      .sort((a, b) => {
        const ai = a.bracket_match_index ?? Number.MAX_SAFE_INTEGER;
        const bi = b.bracket_match_index ?? Number.MAX_SAFE_INTEGER;
        if (ai !== bi) return ai - bi;
        return a.id.localeCompare(b.id);
      })
      .map((m) => {
        const winId = (m as any).winner_id as string | null | undefined;
        const p1Id = m.team1_id;
        const p2Id = m.team2_id;
        const bothPresent = !!p1Id && !!p2Id;

        // winner flag rules:
        // - if winner_id exists, set true/false accordingly
        // - if one side is BYE and no winner_id, favor the non-BYE side
        // - if both present and no winner yet, set null (neutral)
        const p1Winner =
          p1Id
            ? (winId != null
                ? winId === p1Id
                : (bothPresent ? null : (!!p1Id && !p2Id ? true : null)))
            : false;

        const p2Winner =
          p2Id
            ? (winId != null
                ? winId === p2Id
                : (bothPresent ? null : (!!p2Id && !p1Id ? true : null)))
            : false;

        return {
          // carry through a stable identifier so we can open the match
          id: m.id,
          player1: {
            id: p1Id ?? `bye-${m.id}-1`,
            name: p1Id ? nameFor(p1Id) : 'BYE',
            winner: p1Winner,
          },
          player2: {
            id: p2Id ?? `bye-${m.id}-2`,
            name: p2Id ? nameFor(p2Id) : 'BYE',
            winner: p2Winner,
          },
        };
      });

    return { games };
  });
});

async function ensureTournament() {
  if (!accessCode.value) return;
  await session.ensureAnon();
  if (!session.tournament) {
    const t = await session.loadTournamentByCode(accessCode.value);
    if (!t) {
      toast.add({ severity: 'warn', summary: 'Not found', detail: 'Invalid tournament code', life: 2500 });
    }
  }
}

async function loadTeams() {
  if (!session.tournament) return;
  const { data, error } = await supabase
    .from('teams')
    .select('id, full_team_name')
    .eq('tournament_id', session.tournament.id);
  if (error) {
    toast.add({ severity: 'error', summary: 'Failed to load teams', detail: error.message, life: 2500 });
    return;
  }
  const map: Record<string, string> = {};
  (data as Team[]).forEach((t) => (map[t.id] = t.full_team_name));
  teamNameById.value = map;
}

async function loadMatches() {
  if (!session.tournament) {
    matches.value = [];
    return;
  }
  const { data, error } = await supabase
    .from('matches')
    .select('id,tournament_id,pool_id,round_number,team1_id,team2_id,is_live,live_score_team1,live_score_team2,winner_id,match_type,bracket_round,bracket_match_index')
    .eq('tournament_id', session.tournament.id)
    .eq('match_type', 'bracket')
    .order('bracket_round', { ascending: true })
    .order('bracket_match_index', { ascending: true });

  if (error) {
    toast.add({ severity: 'error', summary: 'Failed to load bracket', detail: error.message, life: 3000 });
    matches.value = [];
    return;
  }
  matches.value = (data as Match[]) ?? [];
}

function openMatch(m: Match) {
  router.push({ name: 'match-actions', params: { accessCode: accessCode.value, matchId: m.id } });
}
function openMatchById(id: string) {
  const m = matches.value.find(mm => mm.id === id);
  if (m) openMatch(m);
}

// Realtime subscription
let channel: ReturnType<typeof supabase.channel> | null = null;

async function subscribeRealtime() {
  if (!session.tournament) return;
  if (channel) {
    await channel.unsubscribe();
    channel = null;
  }
  channel = supabase
    .channel('bracket_matches_' + session.tournament.id)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'matches', filter: `tournament_id=eq.${session.tournament.id}` },
      async (payload) => {
        const row = (payload.new ?? payload.old) as Match;
        if (row.match_type === 'bracket') {
          await loadMatches();
        }
      }
    );

  await channel.subscribe();
}

onMounted(async () => {
  if (accessCode.value) session.setAccessCode(accessCode.value);
  loading.value = true;
  try {
    await ensureTournament();
    await loadTeams();
    await loadMatches();
    await subscribeRealtime();
  } finally {
    loading.value = false;
  }
});

onBeforeUnmount(async () => {
  if (channel) {
    await channel.unsubscribe();
    channel = null;
  }
});
</script>

<template>
  <PublicLayout>
    <section class="p-5 sm:p-7">
        <div class="flex items-center justify-between gap-3">
          <div>
            <h2 class="text-2xl font-semibold text-white">Bracket</h2>
            <p class="mt-1 text-white/80">
              Playoff bracket. Tap a match to view actions.
            </p>
          </div>
          <div v-if="loading" class="text-sm text-white/80">Loading…</div>
        </div>

        <div class="mt-6 rounded-xl bg-white/10 ring-1 ring-white/20 p-4 text-white">
          <p class="text-sm text-white/80">Access Code</p>
          <p class="font-semibold tracking-wide">{{ accessCode || '—' }}</p>
        </div>

        <div v-if="matches.length === 0" class="mt-6 rounded-xl border border-dashed border-white/30 p-6 text-center text-white/80">
          No bracket matches yet.
        </div>

        <div v-else class="mt-6">
          <Bracket :rounds="bracketData">
            <template #player="{ player }">
              <div class="text-sm font-semibold text-white">
                {{ player.name }}
              </div>
            </template>
            <template #player-extension-bottom="{ match }">
              <div class="mt-1">
                <button class="underline text-white/80 text-xs" @click="openMatchById(match.id)">
                  View match
                </button>
              </div>
            </template>
          </Bracket>
        </div>

        <div class="mt-8 text-sm text-white/80 text-center">
          Back to
          <router-link class="underline" :to="{ name: 'tournament-public', params: { accessCode } }">
            Tournament
          </router-link>
        </div>
    </section>
  </PublicLayout>
</template>