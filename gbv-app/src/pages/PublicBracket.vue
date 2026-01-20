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
  team1_score: number | null;
  team2_score: number | null;
  is_live: boolean;
  live_score_team1: number | null;
  live_score_team2: number | null;
  live_owner_id: UUID | null;
  live_last_active_at: string | null;
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

const bracketChromeHidden = ref(false);
const mobileBracketOffsetPx = computed(() => (bracketChromeHidden.value ? 140 : 260));
function onBracketViewportScroll(pos: { left: number; top: number }) {
  bracketChromeHidden.value = pos.left > 0 || pos.top > 0;
}

const matches = ref<Match[]>([]);
const teamNameById = ref<Record<string, string>>({});
const courts = ref<string[]>([]);

let refreshTimer: ReturnType<typeof setInterval> | null = null;

function winnerIdFor(m: Match): string | null {
  const winId = m.winner_id ?? null;
  const t1 = m.team1_id ?? null;
  const t2 = m.team2_id ?? null;
  if (winId && (winId === t1 || winId === t2)) return winId;
  if (t1 && t2 && m.team1_score != null && m.team2_score != null) {
    const s1 = m.team1_score ?? 0;
    const s2 = m.team2_score ?? 0;
    if (s1 === s2) return null;
    return s1 > s2 ? t1 : t2;
  }
  return null;
}

const championName = computed(() => {
  if (!matches.value.length) return null;
  const maxRound = Math.max(0, ...matches.value.map((m) => m.bracket_round ?? 0));
  if (!maxRound) return null;
  const finalMatch = matches.value.find((m) => (m.bracket_round ?? 0) === maxRound && (m.bracket_match_index ?? 0) === 0) ?? null;
  if (!finalMatch) return null;
  const winId = winnerIdFor(finalMatch);
  if (!winId) return null;
  return teamNameById.value[winId] ?? 'TBD';
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
    .select('id,tournament_id,pool_id,round_number,team1_id,team2_id,team1_score,team2_score,is_live,live_score_team1,live_score_team2,live_owner_id,live_last_active_at,winner_id,match_type,bracket_round,bracket_match_index')
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

async function loadCourts() {
  if (!session.tournament) {
    courts.value = [];
    return;
  }
  const { data, error } = await supabase
    .from('pools')
    .select('court_assignment')
    .eq('tournament_id', session.tournament.id);
  if (error) {
    courts.value = [];
    return;
  }
  const vals = ((data as Array<{ court_assignment: string | null }>) ?? [])
    .map((p) => (p.court_assignment ?? '').trim())
    .filter(Boolean);

  const uniq = Array.from(new Set(vals));
  uniq.sort((a, b) => {
    const na = Number(a);
    const nb = Number(b);
    const aNum = Number.isFinite(na);
    const bNum = Number.isFinite(nb);
    if (aNum && bNum) return na - nb;
    if (aNum && !bNum) return -1;
    if (!aNum && bNum) return 1;
    return a.localeCompare(b);
  });
  courts.value = uniq;
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
        if (import.meta.env.DEV) console.debug('[Realtime] PublicBracket event', payload);
        const row = (payload.new ?? payload.old) as Match;
        if (row.match_type === 'bracket') {
          await loadMatches();
        }
      }
    );

  await channel.subscribe((status) => {
    if (import.meta.env.DEV) console.debug('[Realtime] PublicBracket status', status);
  });
}

onMounted(async () => {
  if (accessCode.value) session.setAccessCode(accessCode.value);
  loading.value = true;
  try {
    await ensureTournament();
    await loadTeams();
    await loadMatches();
    await loadCourts();
    await subscribeRealtime();
    refreshTimer = setInterval(() => void loadMatches(), 15_000);
  } finally {
    loading.value = false;
  }
});

onBeforeUnmount(async () => {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  if (channel) {
    await channel.unsubscribe();
    channel = null;
  }
});
</script>

<template>
  <PublicLayout :stickyHeader="false">
    <section class="p-5 sm:p-7">
      <div v-show="!bracketChromeHidden" class="flex items-center justify-between gap-3">
        <div>
          <h2 class="text-2xl font-semibold text-white">Bracket</h2>
          <p class="mt-1 text-white/80">
            Playoff bracket. Tap a match to view actions.
          </p>
        </div>
        <div class="flex items-center gap-2">
          <router-link
            :to="{ name: 'public-leaderboard', params: { accessCode } }"
            class="inline-flex items-center rounded-full bg-white/10 px-3 py-1 text-xs font-semibold text-white ring-1 ring-white/20 hover:bg-white/15 transition-colors whitespace-nowrap"
          >
            Leaderboard
          </router-link>
          <div v-if="loading" class="text-sm text-white/80">Loading…</div>
        </div>
      </div>

      <div
        v-if="championName && !bracketChromeHidden"
        class="mt-6 rounded-2xl bg-white/10 ring-2 ring-amber-300/60 p-5 text-center text-white"
      >
        <div class="text-2xl sm:text-3xl font-extrabold leading-tight">
          {{ championName }} WON!! 🎉🎉
        </div>
        <div class="mt-1 text-white/80 font-medium">
          Thank you for playing!
        </div>
      </div>

      <div v-if="matches.length === 0" class="mt-6 rounded-xl border border-dashed border-white/30 p-6 text-center text-white/80">
        No bracket matches yet.
      </div>

      <div v-else :class="bracketChromeHidden ? '' : 'mt-6'">
        <div class="-mx-5 sm:-mx-7">
          <BracketView
            :matches="matches"
            :teamNameById="teamNameById"
            :courts="courts"
            :mobile-max-height-offset-px="mobileBracketOffsetPx"
            @viewport-scroll="onBracketViewportScroll"
            @open="openMatchById"
          />
        </div>
      </div>

      <div v-show="!bracketChromeHidden" class="mt-8 text-sm text-white/80 text-center">
        Back to
        <router-link class="underline" :to="{ name: 'tournament-public', params: { accessCode } }">
          Tournament
        </router-link>
      </div>
    </section>
  </PublicLayout>
</template>
