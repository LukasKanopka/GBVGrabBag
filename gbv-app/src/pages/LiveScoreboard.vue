<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, computed } from 'vue';
import { useRoute } from 'vue-router';
import { useSessionStore } from '../stores/session';
import Button from 'primevue/button';
import { useToast } from 'primevue/usetoast';
import supabase from '../lib/supabase';

type Team = { id: string; full_team_name: string };
type Match = {
  id: string;
  tournament_id: string;
  team1_id: string | null;
  team2_id: string | null;
  is_live: boolean;
  live_score_team1: number | null;
  live_score_team2: number | null;
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
  liveMatchId.value = m.id;
  team1Id.value = m.team1_id;
  team2Id.value = m.team2_id;
  score1.value = Math.max(0, m.live_score_team1 ?? 0);
  score2.value = Math.max(0, m.live_score_team2 ?? 0);
  isLive.value = !!m.is_live;
  const prefix = m.match_type === 'bracket' ? 'Bracket' : 'Pool';
  matchLabel.value = `${prefix}${m.round_number ? ` R${m.round_number}` : ''}: ${nameFor(m.team1_id)} vs ${nameFor(m.team2_id)}`;
}

async function loadCurrentLiveMatch() {
  if (!session.tournament) return;
  // get first live match for this tournament
  const { data, error } = await supabase
    .from('matches')
    .select('id,tournament_id,team1_id,team2_id,is_live,live_score_team1,live_score_team2,match_type,round_number')
    .eq('tournament_id', session.tournament.id)
    .eq('is_live', true)
    .limit(1);
  if (error) {
    toast.add({ severity: 'error', summary: 'Load live match failed', detail: error.message, life: 3000 });
    return;
  }
  setFromMatch((data as Match[])[0] ?? null);
}

async function applyScoreUpdate(newS1: number, newS2: number) {
  if (!liveMatchId.value) return;
  const { error } = await supabase
    .from('matches')
    .update({
      live_score_team1: newS1,
      live_score_team2: newS2,
      is_live: true,
    })
    .eq('id', liveMatchId.value);
  if (error) {
    toast.add({ severity: 'error', summary: 'Update failed', detail: error.message, life: 2500 });
  }
}

async function inc(team: 1 | 2) {
  const ns1 = team === 1 ? score1.value + 1 : score1.value;
  const ns2 = team === 2 ? score2.value + 1 : score2.value;
  score1.value = ns1;
  score2.value = ns2;
  await applyScoreUpdate(ns1, ns2);
}

async function dec(team: 1 | 2) {
  const ns1 = team === 1 ? Math.max(0, score1.value - 1) : score1.value;
  const ns2 = team === 2 ? Math.max(0, score2.value - 1) : score2.value;
  score1.value = ns1;
  score2.value = ns2;
  await applyScoreUpdate(ns1, ns2);
}

async function flipScores() {
  const ns1 = score2.value;
  const ns2 = score1.value;
  score1.value = ns1;
  score2.value = ns2;
  // Names flip purely visual
  const t1 = team1Id.value;
  team1Id.value = team2Id.value;
  team2Id.value = t1;
  await applyScoreUpdate(ns1, ns2);
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
  <section class="mx-auto max-w-4xl px-4 pb-10 pt-6">
    <div class="rounded-2xl border border-slate-200 bg-white shadow-lg">
      <div class="p-5 sm:p-7">
        <div class="flex items-center justify-between">
          <h2 class="text-2xl font-semibold text-slate-900">Live Scoreboard</h2>
          <div
            v-if="isLive"
            class="inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-wide text-white gbv-grad-orange"
            aria-label="Live indicator"
          >
            <span class="size-2 rounded-full bg-white/90"></span>
            LIVE
          </div>
        </div>

        <p class="mt-1 text-slate-600">
          Access Code: <span class="font-semibold">{{ accessCode || '—' }}</span>
        </p>
        <p class="mt-1 text-sm text-slate-500">{{ matchLabel }}</p>

        <div class="mt-6 grid grid-cols-1 gap-6">
          <div class="rounded-xl bg-gbv-bg p-6">
            <div class="grid grid-cols-2 items-center gap-6">
              <div class="text-center">
                <div class="text-sm text-slate-600">Team 1</div>
                <div class="text-3xl sm:text-4xl font-extrabold text-slate-900">{{ team1Id ? (team1Id && (team1Id in teamNameById) ? teamNameById[team1Id] : 'TBD') : 'TBD' }}</div>
              </div>
              <div class="text-center">
                <div class="text-sm text-slate-600">Team 2</div>
                <div class="text-3xl sm:text-4xl font-extrabold text-slate-900">{{ team2Id ? (team2Id && (team2Id in teamNameById) ? teamNameById[team2Id] : 'TBD') : 'TBD' }}</div>
              </div>
            </div>

            <div class="mt-6 grid grid-cols-2 gap-6">
              <div class="flex flex-col items-center">
                <div class="text-7xl sm:text-8xl font-black tabular-nums text-gbv-blue">{{ score1 }}</div>
                <div class="mt-4 flex gap-3">
                  <Button
                    label="+1"
                    size="large"
                    class="!rounded-2xl !px-5 !py-4 !text-xl font-bold border-none text-white gbv-grad-blue"
                    @click="inc(1)"
                  />
                  <Button
                    label="-1"
                    size="large"
                    severity="secondary"
                    class="!rounded-2xl !px-5 !py-4 !text-xl"
                    @click="dec(1)"
                  />
                </div>
              </div>

              <div class="flex flex-col items-center">
                <div class="text-7xl sm:text-8xl font-black tabular-nums text-gbv-orange">{{ score2 }}</div>
                <div class="mt-4 flex gap-3">
                  <Button
                    label="+1"
                    size="large"
                    class="!rounded-2xl !px-5 !py-4 !text-xl font-bold border-none text-white gbv-grad-orange"
                    @click="inc(2)"
                  />
                  <Button
                    label="-1"
                    size="large"
                    severity="secondary"
                    class="!rounded-2xl !px-5 !py-4 !text-xl"
                    @click="dec(2)"
                  />
                </div>
              </div>
            </div>

            <div class="mt-6 flex justify-center">
              <Button
                label="Flip Sides"
                size="large"
                icon="pi pi-refresh"
                class="!rounded-2xl !px-6 !py-4 !text-lg"
                severity="contrast"
                @click="flipScores"
              />
            </div>
          </div>

          <div class="rounded-xl border border-dashed border-slate-300 p-6 text-center text-slate-600">
            This view updates in real-time when the live match row changes in Supabase.
          </div>
        </div>

        <div class="mt-6 text-sm text-slate-600">
          Return to
          <router-link class="text-gbv-blue underline" :to="{ name: 'tournament-public', params: { accessCode } }">
            Tournament
          </router-link>
        </div>
      </div>
    </div>
  </section>
</template>