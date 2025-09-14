<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useSessionStore } from '../stores/session';
import { useToast } from 'primevue/usetoast';
import supabase from '../lib/supabase';

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
  match_type: 'pool' | 'bracket';
  bracket_round: number | null;
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
  // sort each round by id for stability
  const entries = Array.from(map.entries()).sort((a, b) => a[0] - b[0]);
  return entries.map(([r, arr]) => [r, arr.sort((a, b) => a.id.localeCompare(b.id))] as const);
}

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
    .select('id,tournament_id,pool_id,round_number,team1_id,team2_id,is_live,live_score_team1,live_score_team2,match_type,bracket_round')
    .eq('tournament_id', session.tournament.id)
    .eq('match_type', 'bracket')
    .order('bracket_round', { ascending: true })
    .order('id', { ascending: true });

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
  <section class="mx-auto max-w-3xl px-4 pb-10 pt-6">
    <div class="rounded-2xl border border-slate-200 bg-white shadow-lg">
      <div class="p-5 sm:p-7">
        <div class="flex items-center justify-between gap-3">
          <div>
            <h2 class="text-2xl font-semibold text-slate-900">Bracket</h2>
            <p class="mt-1 text-slate-600">
              Playoff bracket. Tap a match to view actions.
            </p>
          </div>
          <div v-if="loading" class="text-sm text-slate-500">Loading…</div>
        </div>

        <div class="mt-6 rounded-xl bg-gbv-bg p-4 text-slate-800">
          <p class="text-sm">Access Code</p>
          <p class="font-semibold tracking-wide">{{ accessCode || '—' }}</p>
        </div>

        <div v-if="matches.length === 0" class="mt-6 rounded-xl border border-dashed border-slate-300 p-6 text-center text-slate-600">
          No bracket matches yet.
        </div>

        <div v-else class="mt-6 space-y-6">
          <div v-for="[r, arr] in groupedByRound()" :key="r" class="rounded-xl border border-slate-200 bg-white">
            <div class="border-b border-slate-200 px-4 py-3">
              <div class="text-sm font-semibold text-slate-700">{{ roundTitle(r) }}</div>
            </div>
            <ul class="p-4 grid gap-3">
              <li
                v-for="m in arr"
                :key="m.id"
                class="cursor-pointer rounded-xl border border-slate-200 bg-white p-4 shadow-sm hover:shadow-md transition-shadow"
                @click="openMatch(m)"
              >
                <div class="flex items-center justify-between">
                  <div class="text-sm text-slate-600">
                    {{ m.match_type === 'bracket' ? 'Bracket' : 'Pool' }}{{ m.round_number ? ` R${m.round_number}` : '' }}
                  </div>
                  <div
                    v-if="m.is_live"
                    class="inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-xs font-semibold uppercase tracking-wide text-white bg-red-600"
                  >
                    <span class="size-2 rounded-full bg-white/90"></span>
                    Live
                  </div>
                </div>
                <div class="mt-1 font-semibold text-slate-900">
                  {{ nameFor(m.team1_id) }} vs {{ nameFor(m.team2_id) }}
                </div>
              </li>
            </ul>
          </div>
        </div>

        <div class="mt-8 text-sm text-slate-600 text-center">
          Back to
          <router-link class="text-gbv-blue underline" :to="{ name: 'tournament-public', params: { accessCode } }">
            Tournament
          </router-link>
        </div>
      </div>
    </div>
  </section>
</template>