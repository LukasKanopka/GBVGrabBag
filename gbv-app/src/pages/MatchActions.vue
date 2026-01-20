<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, computed } from 'vue';
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
  winner_id: UUID | null;
  is_live: boolean;
  live_score_team1: number | null;
  live_score_team2: number | null;
  live_owner_id: UUID | null;
  live_last_active_at: string | null;
  match_type: 'pool' | 'bracket';
};

type Team = { id: UUID; full_team_name: string };

const route = useRoute();
const router = useRouter();
const toast = useToast();
const session = useSessionStore();

const accessCode = computed(() => (route.params.accessCode as string) ?? session.accessCode ?? '');
const matchId = computed(() => route.params.matchId as string);
const from = computed(() => (route.query.from as string | undefined) ?? undefined);

const loading = ref(false);
const match = ref<Match | null>(null);
const teamNameById = ref<Record<string, string>>({});
const now = ref<number>(Date.now());
let nowTimer: ReturnType<typeof setInterval> | null = null;

const LIVE_LEASE_MS = 90 * 1000;
function isLiveActive(m: Match): boolean {
  if (!m.is_live) return false;
  if (!m.live_owner_id) return false;
  if (!m.live_last_active_at) return false;
  const t = Date.parse(m.live_last_active_at);
  if (!Number.isFinite(t)) return false;
  return (now.value - t) <= LIVE_LEASE_MS;
}

let channel: ReturnType<typeof supabase.channel> | null = null;
async function subscribeRealtime() {
  if (!session.tournament || !matchId.value) return;
  if (channel) {
    await channel.unsubscribe();
    channel = null;
  }

  channel = supabase
    .channel('match_actions_' + matchId.value)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'matches', filter: `id=eq.${matchId.value}` },
      (payload) => {
        if (import.meta.env.DEV) console.debug('[Realtime] MatchActions event', payload);
        if (payload.new) {
          match.value = payload.new as Match;
        } else if (payload.eventType === 'DELETE' && match.value?.id === matchId.value) {
          match.value = null;
        }
      }
    );

  await channel.subscribe((status) => {
    if (import.meta.env.DEV) console.debug('[Realtime] MatchActions status', status);
  });
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

async function loadMatch() {
  if (!session.tournament || !matchId.value) {
    match.value = null;
    return;
  }
  const { data, error } = await supabase
    .from('matches')
    .select('id,tournament_id,pool_id,round_number,team1_id,team2_id,ref_team_id,team1_score,team2_score,winner_id,is_live,live_score_team1,live_score_team2,live_owner_id,live_last_active_at,match_type')
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

function isCompleted(m: Match): boolean {
  return m.team1_score != null && m.team2_score != null;
}

function winnerSide(m: Match): 1 | 2 | null {
  if (!m.team1_id || !m.team2_id) return null;
  if (m.winner_id) {
    if (m.winner_id === m.team1_id) return 1;
    if (m.winner_id === m.team2_id) return 2;
  }
  if (!isCompleted(m)) return null;
  if (m.team1_score === m.team2_score) return null;
  return (m.team1_score ?? 0) > (m.team2_score ?? 0) ? 1 : 2;
}

function winnerName(m: Match): string | null {
  const side = winnerSide(m);
  if (side === 1) return nameFor(m.team1_id);
  if (side === 2) return nameFor(m.team2_id);
  return null;
}

function finalScoreText(m: Match): string | null {
  if (!isCompleted(m)) return null;
  return `${m.team1_score ?? 0}\u2013${m.team2_score ?? 0}`;
}


function goManual() {
  if (!match.value) return;
  router.push({ name: 'match-score', params: { accessCode: accessCode.value, matchId: match.value.id }, query: from.value ? { from: from.value } : undefined });
}

function goLive() {
  if (!match.value) return;
  router.push({ name: 'match-live', params: { accessCode: accessCode.value, matchId: match.value.id }, query: from.value ? { from: from.value } : undefined });
}

const backLabel = computed(() => {
  if (from.value === 'admin-bracket') return 'Back to Admin Bracket';
  if (match.value?.match_type === 'bracket') return 'Back to Bracket';
  return 'Back to Pool';
});

function backToContext() {
  if (from.value === 'admin-bracket') {
    router.push({ name: 'admin-bracket' });
    return;
  }

  if (match.value?.match_type === 'bracket') {
    router.push({ name: 'public-bracket', params: { accessCode: accessCode.value } });
    return;
  }

  if (!match.value?.pool_id) {
    router.push({ name: 'public-pool-list', params: { accessCode: accessCode.value } });
    return;
  }
  router.push({ name: 'public-pool-details', params: { accessCode: accessCode.value, poolId: match.value.pool_id } });
}

onMounted(async () => {
  if (accessCode.value) session.setAccessCode(accessCode.value);
  nowTimer = setInterval(() => (now.value = Date.now()), 15_000);
  loading.value = true;
  try {
    await ensureTournament();
    await loadTeams();
    await loadMatch();
    await subscribeRealtime();
  } finally {
    loading.value = false;
  }
});

onBeforeUnmount(() => {
  if (nowTimer) {
    clearInterval(nowTimer);
    nowTimer = null;
  }
  if (channel) {
    void channel.unsubscribe();
    channel = null;
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
          <div
            v-if="isLiveActive(match)"
            class="inline-flex items-center gap-2 rounded-full bg-red-600 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-white"
          >
            <span class="size-2 rounded-full bg-white/90"></span>
            LIVE
            <span class="tabular-nums">{{ match.live_score_team1 ?? 0 }}-{{ match.live_score_team2 ?? 0 }}</span>
          </div>
        </div>
        <div class="mt-2">
          <div class="text-xl font-semibold text-white leading-tight">
            {{ nameFor(match.team1_id) }}
          </div>
          <div class="text-sm font-medium text-white/70 leading-tight">
            vs
          </div>
          <div class="text-xl font-semibold text-white leading-tight">
            {{ nameFor(match.team2_id) }}
          </div>
        </div>

        <div
          v-if="isLiveActive(match)"
          class="mt-5 rounded-2xl bg-white/10 p-4 text-white ring-2 ring-red-500/60"
        >
          <div class="flex items-center justify-between gap-3">
            <div class="text-sm font-semibold uppercase tracking-wide text-white/80">Live Score</div>
            <div class="inline-flex items-center gap-2 rounded-full bg-red-600 px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide text-white whitespace-nowrap">
              <span class="size-2 rounded-full bg-white/90"></span>
              LIVE <span class="tabular-nums">{{ match.live_score_team1 ?? 0 }}-{{ match.live_score_team2 ?? 0 }}</span>
            </div>
          </div>
          <div class="mt-3 grid grid-cols-2 gap-3">
            <div class="rounded-xl bg-white/5 ring-1 ring-white/15 p-3">
              <div class="text-xs font-medium text-white/70 truncate">{{ nameFor(match.team1_id) }}</div>
              <div class="mt-1 text-4xl font-black tabular-nums text-white">{{ match.live_score_team1 ?? 0 }}</div>
            </div>
            <div class="rounded-xl bg-white/5 ring-1 ring-white/15 p-3">
              <div class="text-xs font-medium text-white/70 truncate">{{ nameFor(match.team2_id) }}</div>
              <div class="mt-1 text-4xl font-black tabular-nums text-white">{{ match.live_score_team2 ?? 0 }}</div>
            </div>
          </div>
        </div>

        <div
          v-else-if="isCompleted(match)"
          class="mt-5 rounded-2xl bg-white/10 p-4 text-white ring-1 ring-white/20"
        >
          <div class="flex items-center justify-between gap-3">
            <div class="text-sm font-semibold uppercase tracking-wide text-white/80">Final</div>
            <div class="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide bg-white/10 ring-1 ring-white/20 text-white whitespace-nowrap">
              <span class="tabular-nums">{{ finalScoreText(match) }}</span>
            </div>
          </div>
          <div class="mt-3 grid grid-cols-2 gap-3">
            <div class="rounded-xl bg-white/5 ring-1 ring-white/15 p-3">
              <div
                class="text-xs font-medium text-white/70 truncate"
                :class="winnerSide(match) === 2 ? 'opacity-70 line-through decoration-2 decoration-white/70' : ''"
              >
                {{ nameFor(match.team1_id) }}
              </div>
              <div class="mt-1 text-4xl font-black tabular-nums text-white">{{ match.team1_score ?? 0 }}</div>
            </div>
            <div class="rounded-xl bg-white/5 ring-1 ring-white/15 p-3">
              <div
                class="text-xs font-medium text-white/70 truncate"
                :class="winnerSide(match) === 1 ? 'opacity-70 line-through decoration-2 decoration-white/70' : ''"
              >
                {{ nameFor(match.team2_id) }}
              </div>
              <div class="mt-1 text-4xl font-black tabular-nums text-white">{{ match.team2_score ?? 0 }}</div>
            </div>
          </div>
          <div class="mt-3 flex items-center justify-between gap-3">
            <div class="text-sm text-white/80">Winner</div>
            <div
              v-if="winnerName(match)"
              class="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-extrabold tracking-wide uppercase bg-amber-300/90 text-slate-900 ring-1 ring-amber-200/70 max-w-[70%] truncate"
            >
              {{ winnerName(match) }}
            </div>
            <div v-else class="text-sm text-white/70">—</div>
          </div>
        </div>

        <div class="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Button
            label="Enter Final Score"
            icon="pi pi-pencil"
            severity="secondary"
            size="large"
            class="!rounded-2xl !px-6 !py-4 !text-lg !font-semibold text-white bg-white/10 ring-1 ring-white/20"
            @click="goManual"
          />
          <Button
            :label="isLiveActive(match) ? 'View Live Score' : 'Use Live Scoreboard'"
            icon="pi pi-bolt"
            severity="secondary"
            size="large"
            class="!rounded-2xl !px-6 !py-4 !text-lg !font-semibold text-white bg-white/10 ring-1 ring-white/20"
            @click="goLive"
          />
        </div>

      </div>

      <div class="mt-8 text-sm text-white/80 text-center">
        <button class="underline text-white" @click="backToContext">{{ backLabel }}</button>
      </div>
    </section>
  </PublicLayout>
</template>
