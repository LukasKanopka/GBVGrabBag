<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useSessionStore } from '../stores/session';
import Dropdown from 'primevue/dropdown';
import InputNumber from 'primevue/inputnumber';
import Button from 'primevue/button';
import { useToast } from 'primevue/usetoast';
import supabase from '../lib/supabase';
import PublicLayout from '../components/layout/PublicLayout.vue';

type Team = { id: string; full_team_name: string };
type MatchRow = {
  id: string;
  pool_id: string | null;
  round_number: number | null;
  team1_id: string | null;
  team2_id: string | null;
  team1_score: number | null;
  team2_score: number | null;
  match_type: 'pool' | 'bracket';
};

const toast = useToast();
const route = useRoute();
const session = useSessionStore();
const router = useRouter();

const accessCode = computed(() => (route.params.accessCode as string) ?? session.accessCode ?? '');
const loading = ref(false);

const teamNameById = ref<Record<string, string>>({});
type MatchOption = {
  id: string;
  label: string;
  team1_id: string | null;
  team2_id: string | null;
  pool_id: string | null;
  match_type: 'pool' | 'bracket';
};
const matches = ref<MatchOption[]>([]);
const selectedMatch = ref<MatchOption | null>(null);
const team1Score = ref<number | null>(null);
const team2Score = ref<number | null>(null);

async function ensureTournament() {
  if (!accessCode.value) return;
  await session.ensureAnon();
  if (!session.tournament) {
    await session.loadTournamentByCode(accessCode.value);
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

function nameFor(id: string | null) {
  return (id && teamNameById.value[id]) || 'TBD';
}

async function loadMatches() {
  if (!session.tournament) return;
  const { data, error } = await supabase
    .from('matches')
    .select('id, pool_id, round_number, team1_id, team2_id, team1_score, team2_score, match_type')
    .eq('tournament_id', session.tournament.id)
    .order('round_number', { ascending: true })
    .order('id', { ascending: true });
  if (error) {
    toast.add({ severity: 'error', summary: 'Failed to load matches', detail: error.message, life: 2500 });
    return;
  }
  const rows = (data as MatchRow[]).map((m) => {
    const label = `${m.match_type === 'bracket' ? 'Bracket' : 'Pool'}${m.round_number ? ` R${m.round_number}` : ''}: ${nameFor(m.team1_id)} vs ${nameFor(m.team2_id)}`;
    return { id: m.id, label, team1_id: m.team1_id, team2_id: m.team2_id, pool_id: m.pool_id, match_type: m.match_type };
  });
  matches.value = rows;
}

async function submitScore() {
  if (!selectedMatch.value || team1Score.value == null || team2Score.value == null) return;
  const { id, team1_id, team2_id } = selectedMatch.value;
  const t1 = team1Score.value;
  const t2 = team2Score.value;
  let winner_id: string | null = null;
  if (team1_id && team2_id) {
    if (t1 > t2) winner_id = team1_id;
    else if (t2 > t1) winner_id = team2_id;
  }

  if (!session.tournament) {
    toast.add({ severity: 'error', summary: 'Submit failed', detail: 'Missing tournament context', life: 3000 });
    return;
  }

  // Instrumentation to detect silent 204/no-op (likely RLS or wrong filter)
  console.debug('[ScoreEntry] submitScore update', { id, t1, t2, winner_id });

  const { data, error } = await supabase
    .from('matches')
    .update({
      team1_score: t1,
      team2_score: t2,
      winner_id,
      is_live: false, // score submitted -> mark not live
      live_score_team1: null,
      live_score_team2: null,
    })
    .eq('id', id)
    .select('id, team1_score, team2_score, winner_id')
    .single();

  console.debug('[ScoreEntry] update result', { hasData: !!data, error });

  if (error) {
    toast.add({ severity: 'error', summary: 'Submit failed', detail: error.message, life: 3000 });
    return;
  }
  if (!data) {
    toast.add({
      severity: 'error',
      summary: 'No rows updated',
      detail: 'Update likely blocked by Row Level Security. Ensure anonymous auth is enabled or relax RLS for updates.',
      life: 4000
    });
    return;
  }

  toast.add({ severity: 'success', summary: 'Score submitted', life: 1500 });

  // If this was a bracket match, ensure the tournament is marked as started (first activity)
  if (selectedMatch.value?.match_type === 'bracket' && session.tournament) {
    await supabase
      .from('tournaments')
      .update({ bracket_started: true })
      .eq('id', session.tournament.id)
      .eq('bracket_started', false);
  }

  // Navigate to pool standings if pool match; else back to the match actions page
  if (selectedMatch.value?.match_type === 'pool' && selectedMatch.value?.pool_id) {
    router.push({ name: 'public-pool-details', params: { accessCode: accessCode.value, poolId: selectedMatch.value.pool_id } });
  } else {
    router.push({ name: 'match-actions', params: { accessCode: accessCode.value, matchId: id } });
  }
}

onMounted(async () => {
  if (accessCode.value) session.setAccessCode(accessCode.value);
  loading.value = true;
  try {
    await ensureTournament();
    await loadTeams();
    await loadMatches();
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <PublicLayout>
    <section class="p-5 sm:p-7">
      <div class="flex items-center justify-between">
        <h2 class="text-2xl font-semibold text-white">Score Entry</h2>
        <div v-if="loading" class="text-sm text-white/80">Loading…</div>
      </div>
      <p class="mt-1 text-white/80">
        Submit final scores for completed matches. Validation and tiebreakers apply on the server.
      </p>

      <div class="mt-4 rounded-xl bg-white/10 ring-1 ring-white/20 p-4 text-white">
        <p class="text-sm text-white/80">
          Access Code:
          <span class="font-semibold text-white">{{ accessCode || '—' }}</span>
        </p>
      </div>

      <div class="mt-6 grid gap-5">
        <div>
          <label class="block text-sm font-medium text-white/80 mb-2">Select Match</label>
          <Dropdown
            v-model="selectedMatch"
            :options="matches"
            optionLabel="label"
            placeholder="Choose a match..."
            class="w-full !rounded-xl"
            :pt="{ input: { class: '!py-3 !px-4 !text-base !rounded-xl' } }"
          />
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-5">
          <div>
            <label class="block text-sm font-medium text-white/80 mb-2">Team 1 Score</label>
            <InputNumber
              v-model="team1Score"
              showButtons
              :min="0"
              class="w-full"
              :pt="{
                root: { class: 'w-full' },
                input: { class: '!w-full !py-3 !px-4 !text-xl !rounded-xl' },
                incrementButton: { class: '!rounded-r-xl' },
                decrementButton: { class: '!rounded-l-xl' }
              }"
            />
          </div>

          <div>
            <label class="block text-sm font-medium text-white/80 mb-2">Team 2 Score</label>
            <InputNumber
              v-model="team2Score"
              showButtons
              :min="0"
              class="w-full"
              :pt="{
                root: { class: 'w-full' },
                input: { class: '!w-full !py-3 !px-4 !text-xl !rounded-xl' },
                incrementButton: { class: '!rounded-r-xl' },
                decrementButton: { class: '!rounded-l-xl' }
              }"
            />
          </div>
        </div>

        <div class="flex items-center justify-center">
          <Button
            :disabled="!selectedMatch || team1Score === null || team2Score === null"
            label="Submit Score"
            size="large"
            icon="pi pi-check-circle"
            class="!rounded-2xl !px-6 !py-4 !text-lg !font-semibold border-none text-white gbv-grad-blue"
            @click="submitScore"
          />
        </div>
      </div>

      <div class="mt-8 text-sm text-white/80 text-center">
        Return to
        <router-link class="underline" :to="{ name: 'tournament-public', params: { accessCode } }">
          Tournament
        </router-link>
      </div>
    </section>
  </PublicLayout>
</template>