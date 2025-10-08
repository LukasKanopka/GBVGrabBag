<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import InputNumber from 'primevue/inputnumber';
import Button from 'primevue/button';
import { useToast } from 'primevue/usetoast';
import supabase from '../lib/supabase';
import { useSessionStore } from '../stores/session';
import PublicLayout from '../components/layout/PublicLayout.vue';
import { advanceWinnerToNextById } from '../lib/bracket';

type UUID = string;

type Team = { id: UUID; full_team_name: string };

type Match = {
  id: UUID;
  pool_id: UUID | null;
  round_number: number | null;
  team1_id: UUID | null;
  team2_id: UUID | null;
  team1_score: number | null;
  team2_score: number | null;
  winner_id: UUID | null;
  is_live: boolean;
  live_score_team1: number | null;
  live_score_team2: number | null;
  match_type: 'pool' | 'bracket';
};

const toast = useToast();
const route = useRoute();
const router = useRouter();
const session = useSessionStore();

const accessCode = computed(() => (route.params.accessCode as string) ?? session.accessCode ?? '');
const matchId = computed(() => route.params.matchId as string);

const loading = ref(false);
const teamNameById = ref<Record<string, string>>({});
const match = ref<Match | null>(null);

const team1Score = ref<number | null>(null);
const team2Score = ref<number | null>(null);

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

function nameFor(id: string | null) {
  return (id && teamNameById.value[id]) || 'TBD';
}

async function loadMatch() {
  if (!session.tournament || !matchId.value) return;
  const { data, error } = await supabase
    .from('matches')
    .select('id,pool_id,round_number,team1_id,team2_id,team1_score,team2_score,winner_id,is_live,live_score_team1,live_score_team2,match_type')
    .eq('tournament_id', session.tournament.id)
    .eq('id', matchId.value)
    .single();
  if (error || !data) {
    toast.add({ severity: 'error', summary: 'Failed to load match', detail: error?.message ?? 'Not found', life: 3000 });
    return;
  }
  match.value = data as Match;

  // Initialize score fields: prefer existing final scores, else live scores, else 0
  if (match.value.team1_score != null && match.value.team2_score != null) {
    team1Score.value = match.value.team1_score;
    team2Score.value = match.value.team2_score;
  } else {
    team1Score.value = match.value.live_score_team1 ?? 0;
    team2Score.value = match.value.live_score_team2 ?? 0;
  }
}

async function submitScore() {
  if (!match.value || team1Score.value == null || team2Score.value == null) return;

  // Post-bracket warning (non-blocking)
  if (session.tournament?.status === 'bracket' || session.tournament?.bracket_started) {
    toast.add({
      severity: 'warn',
      summary: 'Bracket already generated',
      detail: 'Updating pool scores may require bracket regeneration.',
      life: 3000,
    });
  }

  const { id, team1_id, team2_id } = match.value;
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

  // Instrumentation to diagnose silent 204/no-op updates (likely RLS/authorization)
  console.debug('[ScoreEntryMatch] submitScore update', { id, t1, t2, winner_id });

  const { data, error } = await supabase
    .from('matches')
    .update({
      team1_score: t1,
      team2_score: t2,
      winner_id,
      is_live: false,          // end live session if any
      live_score_team1: null,  // clear live scores
      live_score_team2: null,
    })
    .eq('id', id)
    .select('id, team1_score, team2_score, winner_id')
    .single();

  console.debug('[ScoreEntryMatch] update result', { hasData: !!data, error });

  if (error) {
    toast.add({ severity: 'error', summary: 'Submit failed', detail: error.message, life: 3000 });
    return;
  }
  if (!data) {
    toast.add({
      severity: 'error',
      summary: 'No rows updated',
      detail: 'Update likely blocked by Row Level Security. Enable anonymous auth or adjust RLS policy for updates on matches.',
      life: 4000
    });
    return;
  }

  // If this was a bracket match, flip bracket_started = true (first activity)
  if (match.value.match_type === 'bracket' && session.tournament) {
    await supabase
      .from('tournaments')
      .update({ bracket_started: true })
      .eq('id', session.tournament.id)
      .eq('bracket_started', false);

    // Auto-advance winner into next round slot (do not overwrite manual changes)
    if (winner_id) {
      await advanceWinnerToNextById(session.tournament.id, id);
    }
  }

  toast.add({ severity: 'success', summary: 'Score submitted', life: 1800 });
  // Navigate to pool standings if this was a pool match; else back to match actions
  if (match.value?.match_type === 'pool' && match.value?.pool_id) {
    router.push({ name: 'public-pool-details', params: { accessCode: accessCode.value, poolId: match.value.pool_id } });
  } else {
    router.push({ name: 'match-actions', params: { accessCode: accessCode.value, matchId: id } });
  }
}

function backToMatch() {
  if (!match.value) {
    router.push({ name: 'public-pool-list', params: { accessCode: accessCode.value } });
    return;
  }
  router.push({ name: 'match-actions', params: { accessCode: accessCode.value, matchId: match.value.id } });
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
        <h2 class="text-2xl font-semibold text-white">Enter Score</h2>
        <div v-if="loading" class="text-sm text-white/80">Loading…</div>
      </div>
      <p class="mt-1 text-white/80">
        Submit final scores for this match.
      </p>

      <div v-if="match" class="mt-4 rounded-xl bg-white/10 ring-1 ring-white/20 p-4 text-white">
        <div class="text-sm text-white/80">
          {{ match.match_type === 'bracket' ? 'Bracket' : 'Pool' }}{{ match.round_number ? ` R${match.round_number}` : '' }}:
          <span class="font-semibold">{{ nameFor(match.team1_id) }}</span>
          vs
          <span class="font-semibold">{{ nameFor(match.team2_id) }}</span>
        </div>
      </div>

      <div class="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-5">
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

      <div class="mt-6 flex items-center justify-center">
        <Button
          :disabled="!match || team1Score === null || team2Score === null"
          label="Submit Score"
          severity="secondary"
          size="large"
          icon="pi pi-check-circle"
          class="!rounded-2xl !px-6 !py-4 !text-lg !font-semibold text-white bg-white/10 ring-1 ring-white/20"
          @click="submitScore"
        />
      </div>

      <div class="mt-8 text-sm text-white/80 text-center">
        <button class="underline text-white" @click="backToMatch">Back to Match</button>
      </div>
    </section>
  </PublicLayout>
</template>