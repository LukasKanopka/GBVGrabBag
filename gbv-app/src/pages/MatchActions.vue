<script setup lang="ts">
import { onMounted, ref, computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Button from 'primevue/button';
import { useToast } from 'primevue/usetoast';
import supabase from '../lib/supabase';
import { useSessionStore } from '../stores/session';

type UUID = string;

type Match = {
  id: UUID;
  tournament_id: UUID;
  pool_id: UUID | null;
  round_number: number | null;
  team1_id: UUID | null;
  team2_id: UUID | null;
  ref_team_id: UUID | null;
  team1_score: number | null;
  team2_score: number | null;
  is_live: boolean;
  match_type: 'pool' | 'bracket';
};

type Team = { id: UUID; full_team_name: string };

const route = useRoute();
const router = useRouter();
const toast = useToast();
const session = useSessionStore();

const accessCode = computed(() => (route.params.accessCode as string) ?? session.accessCode ?? '');
const matchId = computed(() => route.params.matchId as string);

const loading = ref(false);
const match = ref<Match | null>(null);
const teamNameById = ref<Record<string, string>>({});

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

async function loadMatch() {
  if (!session.tournament || !matchId.value) {
    match.value = null;
    return;
  }
  const { data, error } = await supabase
    .from('matches')
    .select('id,tournament_id,pool_id,round_number,team1_id,team2_id,ref_team_id,team1_score,team2_score,is_live,match_type')
    .eq('id', matchId.value)
    .eq('tournament_id', session.tournament.id)
    .single();

  if (error || !data) {
    toast.add({ severity: 'error', summary: 'Failed to load match', detail: error?.message ?? 'Not found', life: 3000 });
    match.value = null;
    return;
  }
  match.value = data as Match;
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

function nameFor(id: string | null) {
  return (id && teamNameById.value[id]) || 'TBD';
}

function goLive() {
  if (!match.value) return;
  if (match.value.is_live) {
    toast.add({ severity: 'warn', summary: 'Match is live', detail: 'Live scoreboard already in use for this match.', life: 2000 });
    return;
  }
  router.push({ name: 'match-live', params: { accessCode: accessCode.value, matchId: match.value.id } });
}

function goManual() {
  if (!match.value) return;
  router.push({ name: 'match-score', params: { accessCode: accessCode.value, matchId: match.value.id } });
}

function backToPool() {
  if (!match.value?.pool_id) {
    router.push({ name: 'public-pool-list', params: { accessCode: accessCode.value } });
    return;
  }
  router.push({ name: 'public-pool-details', params: { accessCode: accessCode.value, poolId: match.value.pool_id } });
}

onMounted(async () => {
  if (accessCode.value) session.setAccessCode(accessCode.value);
  loading.value = true;
  try {
    await ensureTournament();
    await loadTeams();
    await loadMatch();
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <section class="mx-auto max-w-3xl px-4 pb-10 pt-6">
    <div class="rounded-2xl border border-slate-200 bg-white shadow-lg">
      <div class="p-5 sm:p-7">
        <div class="flex items-center justify-between">
          <h2 class="text-2xl font-semibold text-slate-900">Match</h2>
          <div v-if="loading" class="text-sm text-slate-500">Loading…</div>
        </div>

        <div v-if="match" class="mt-3">
          <div class="flex items-center justify-between">
            <div class="text-sm text-slate-600">
              Round {{ match.round_number ?? '—' }} • {{ match.match_type === 'bracket' ? 'Bracket' : 'Pool' }}
            </div>
            <div
              v-if="match.is_live"
              class="inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-wide text-white bg-red-600"
            >
              <span class="size-2 rounded-full bg-white/90"></span>
              Live
            </div>
          </div>
          <div class="mt-2 text-xl font-semibold text-slate-900">
            {{ nameFor(match.team1_id) }} vs {{ nameFor(match.team2_id) }}
          </div>

          <div class="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Button
              label="Live Score Recording with Scoreboard"
              icon="pi pi-bolt"
              class="!rounded-2xl !px-6 !py-4 !text-lg !font-semibold border-none text-white gbv-grad-orange"
              :disabled="match.is_live"
              @click="goLive"
            />
            <Button
              label="Enter Score Manually"
              icon="pi pi-pencil"
              class="!rounded-2xl !px-6 !py-4 !text-lg !font-semibold border-none text-white gbv-grad-blue"
              @click="goManual"
            />
          </div>

          <div v-if="match.is_live" class="mt-3 text-sm text-slate-600">
            Live scoreboard is active on another device. Manual score entry remains available.
          </div>
        </div>

        <div class="mt-8 text-sm text-slate-600 text-center">
          <button class="text-gbv-blue underline" @click="backToPool">Back to Pool</button>
        </div>
      </div>
    </div>
  </section>
</template>