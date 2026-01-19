<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, computed } from 'vue';
import { useRoute } from 'vue-router';
import { useSessionStore } from '../stores/session';
import { useToast } from 'primevue/usetoast';
import supabase from '../lib/supabase';
import PublicLayout from '../components/layout/PublicLayout.vue';

type Team = { id: string; full_team_name: string };
type Match = {
  id: string;
  tournament_id: string;
  team1_id: string | null;
  team2_id: string | null;
  is_live: boolean;
  live_score_team1: number | null;
  live_score_team2: number | null;
  live_last_active_at: string | null;
  match_type: 'pool' | 'bracket';
  round_number: number | null;
};

const route = useRoute();
const session = useSessionStore();
const toast = useToast();

const accessCode = computed(() => (route.params.accessCode as string) ?? session.accessCode ?? '');

const liveMatchId = ref<string | null>(null);
const team1Id = ref<string | null>(null);
const team2Id = ref<string | null>(null);
const score1 = ref<number>(0);
const score2 = ref<number>(0);
const isLive = ref<boolean>(false);
const matchLabel = ref<string>('No live match');
const matchType = ref<'pool' | 'bracket' | null>(null);
const LIVE_STALE_MS = 4 * 60 * 1000;

// team names cache
const teamNameById = ref<Record<string, string>>({});

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
    toast.add({ severity: 'error', summary: 'Teams load failed', detail: error.message, life: 2500 });
    return;
  }
  const map: Record<string, string> = {};
  (data as Team[]).forEach((t) => (map[t.id] = t.full_team_name));
  teamNameById.value = map;
}

function nameFor(id: string | null) {
  return (id && teamNameById.value[id]) || 'TBD';
}

function setFromMatch(m: Match | null) {
  if (!m) {
    liveMatchId.value = null;
    team1Id.value = null;
    team2Id.value = null;
    score1.value = 0;
    score2.value = 0;
    isLive.value = false;
    matchLabel.value = 'No live match';
    return;
  }
  if (m.live_last_active_at) {
    const t = Date.parse(m.live_last_active_at);
    if (Number.isFinite(t) && (Date.now() - t) > LIVE_STALE_MS) {
      // stale session: don't show as live
      setFromMatch(null);
      return;
    }
  }
  liveMatchId.value = m.id;
  team1Id.value = m.team1_id;
  team2Id.value = m.team2_id;
  score1.value = Math.max(0, m.live_score_team1 ?? 0);
  score2.value = Math.max(0, m.live_score_team2 ?? 0);
  isLive.value = !!m.is_live;
  matchType.value = m.match_type;
  const prefix = m.match_type === 'bracket' ? 'Bracket' : 'Pool';
  matchLabel.value = `${prefix}${m.round_number ? ` R${m.round_number}` : ''}: ${nameFor(m.team1_id)} vs ${nameFor(m.team2_id)}`;
}

async function loadCurrentLiveMatch() {
  if (!session.tournament) return;
  // get first live match for this tournament
  const { data, error } = await supabase
    .from('matches')
    .select('id,tournament_id,team1_id,team2_id,is_live,live_score_team1,live_score_team2,live_last_active_at,match_type,round_number')
    .eq('tournament_id', session.tournament.id)
    .eq('is_live', true)
    .limit(1);
  if (error) {
    toast.add({ severity: 'error', summary: 'Load live match failed', detail: error.message, life: 3000 });
    return;
  }
  setFromMatch((data as Match[])[0] ?? null);
}

let channel: ReturnType<typeof supabase.channel> | null = null;

async function subscribeRealtime() {
  if (!session.tournament) return;
  // cleanup existing
  if (channel) {
    await channel.unsubscribe();
    channel = null;
  }
  channel = supabase
    .channel('matches_live_' + session.tournament.id)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'matches',
        filter: `tournament_id=eq.${session.tournament.id}`,
      },
      (payload) => {
        const row = (payload.new ?? payload.old) as Match;
        // if current live match updated or a new live match started, reflect it
        if (payload.new) {
          const m = payload.new as Match;
          if (m.is_live) {
            // if no current or it's the same, set/refresh
            if (!liveMatchId.value || liveMatchId.value === m.id) {
              setFromMatch(m);
            }
          } else {
            // If current match turned not live, clear it
            if (liveMatchId.value === m.id) {
              setFromMatch(null);
            }
          }
        } else if (payload.eventType === 'DELETE' && liveMatchId.value === row.id) {
          setFromMatch(null);
        }
      }
    );

  await channel.subscribe((status) => {
    if (status === 'SUBSCRIBED') {
      // initial fetch
      void loadCurrentLiveMatch();
    }
  });
}

onMounted(async () => {
  if (accessCode.value) session.setAccessCode(accessCode.value);
  await ensureTournament();
  await loadTeams();
  await loadCurrentLiveMatch();
  await subscribeRealtime();
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
        <div class="flex items-center justify-between">
          <h2 class="text-2xl font-semibold text-white">Live Scoreboard</h2>
          <div
            v-if="isLive"
            class="inline-flex items-center gap-2 rounded-full bg-red-600 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-white"
            aria-label="Live indicator"
          >
            <span class="size-2 rounded-full bg-white/90"></span>
            LIVE
          </div>
        </div>

        <p class="mt-1 text-white/80">
          Access Code: <span class="font-semibold text-white">{{ accessCode || '—' }}</span>
        </p>
        <p class="mt-1 text-sm text-white/80">{{ matchLabel }}</p>

        <div class="mt-6 grid grid-cols-1 gap-6">
          <div class="rounded-xl bg-white/10 ring-1 ring-white/20 p-6">
            <div class="grid grid-cols-2 items-center gap-6">
              <div class="text-center">
                <div class="text-sm text-white/80">Team 1</div>
                <div class="text-3xl sm:text-4xl font-extrabold text-white">{{ team1Id ? (team1Id && (team1Id in teamNameById) ? teamNameById[team1Id] : 'TBD') : 'TBD' }}</div>
              </div>
              <div class="text-center">
                <div class="text-sm text-white/80">Team 2</div>
                <div class="text-3xl sm:text-4xl font-extrabold text-white">{{ team2Id ? (team2Id && (team2Id in teamNameById) ? teamNameById[team2Id] : 'TBD') : 'TBD' }}</div>
              </div>
            </div>

            <div class="mt-6 grid grid-cols-2 gap-6">
              <div class="flex flex-col items-center">
                <div class="text-7xl sm:text-8xl font-black tabular-nums text-gbv-blue">{{ score1 }}</div>
              </div>

              <div class="flex flex-col items-center">
                <div class="text-7xl sm:text-8xl font-black tabular-nums text-gbv-orange">{{ score2 }}</div>
              </div>
            </div>
          </div>

          <div class="rounded-xl border border-dashed border-white/30 p-6 text-center text-white/80">
            This view updates in real-time when the live match row changes in Supabase.
          </div>
        </div>

        <div class="mt-6 text-sm text-white/80">
          Return to
          <router-link class="underline" :to="{ name: 'tournament-public', params: { accessCode } }">
            Tournament
          </router-link>
        </div>
    </section>
  </PublicLayout>
</template>
