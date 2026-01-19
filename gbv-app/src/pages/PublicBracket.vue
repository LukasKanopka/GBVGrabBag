<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useSessionStore } from '../stores/session';
import { useToast } from 'primevue/usetoast';
import supabase from '../lib/supabase';
import PublicLayout from '../components/layout/PublicLayout.vue';
import BracketView from '../components/BracketView.vue';

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
          <div class="-mx-5 sm:-mx-7">
            <BracketView :matches="matches" :teamNameById="teamNameById" @open="openMatchById" />
          </div>
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
