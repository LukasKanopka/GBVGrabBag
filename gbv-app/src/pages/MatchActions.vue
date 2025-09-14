<script setup lang="ts">
import { onMounted, ref, computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Button from 'primevue/button';
import { useToast } from 'primevue/usetoast';
import supabase from '../lib/supabase';
import { useSessionStore } from '../stores/session';
import PublicLayout from '../components/layout/PublicLayout.vue';

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
  <PublicLayout>
    <section class="p-5 sm:p-7">
      <div class="flex items-center justify-between">
        <h2 class="text-2xl font-semibold text-white">Match</h2>
        <div v-if="loading" class="text-sm text-white/80">Loading…</div>
      </div>

      <div v-if="match" class="mt-3">
        <div class="flex items-center justify-between">
          <div class="text-sm text-white/80">
            Round {{ match.round_number ?? '—' }} • {{ match.match_type === 'bracket' ? 'Bracket' : 'Pool' }}
          </div>
        </div>
        <div class="mt-2 text-xl font-semibold text-white">
          {{ nameFor(match.team1_id) }} vs {{ nameFor(match.team2_id) }}
        </div>

        <div class="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Button
            label="Enter Score Manually"
            icon="pi pi-pencil"
            class="!rounded-2xl !px-6 !py-4 !text-lg !font-semibold border-none text-white gbv-grad-blue"
            @click="goManual"
          />
        </div>

      </div>

      <div class="mt-8 text-sm text-white/80 text-center">
        <button class="underline text-white" @click="backToPool">Back to Pool</button>
      </div>
    </section>
  </PublicLayout>
</template>