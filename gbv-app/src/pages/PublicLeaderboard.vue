<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, computed } from 'vue';
import { useRoute } from 'vue-router';
import { useToast } from 'primevue/usetoast';
import supabase from '../lib/supabase';
import { useSessionStore } from '../stores/session';
import PublicLayout from '../components/layout/PublicLayout.vue';

type UUID = string;

type Team = {
  id: UUID;
  full_team_name: string;
  seed_global: number | null;
};

type Match = {
  id: UUID;
  pool_id: UUID | null;
  round_number: number | null;
  team1_id: UUID | null;
  team2_id: UUID | null;
  ref_team_id: UUID | null;
  team1_score: number | null;
  team2_score: number | null;
  winner_id: UUID | null;
  match_type: 'pool' | 'bracket';
};

type Standing = {
  teamId: UUID;
  name: string;
  wins: number;
  losses: number;
  played: number;
  setWon: number;
  setLost: number;
  setRatio: number;
  pointsFor: number;
  pointsAgainst: number;
  pointDiff: number;
  seed: number | null;
};

const route = useRoute();
const toast = useToast();
const session = useSessionStore();

const accessCode = computed(() => (route.params.accessCode as string) ?? session.accessCode ?? '');

const loading = ref(false);
const teams = ref<Team[]>([]);
const matches = ref<Match[]>([]);
const standings = ref<Standing[]>([]);

let refreshTimer: ReturnType<typeof setInterval> | null = null;
let channel: ReturnType<typeof supabase.channel> | null = null;

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
  if (!session.tournament) {
    teams.value = [];
    return;
  }
  const { data, error } = await supabase
    .from('teams')
    .select('id, full_team_name, seed_global')
    .eq('tournament_id', session.tournament.id);

  if (error) {
    toast.add({ severity: 'error', summary: 'Failed to load teams', detail: error.message, life: 3000 });
    teams.value = [];
    return;
  }
  teams.value = (data as Team[]) ?? [];
}

function dedupePoolMatches(raw: Match[]): Match[] {
  const seen = new Set<string>();
  return raw.filter((m) => {
    const a = m.team1_id ?? 'null';
    const b = m.team2_id ?? 'null';
    const [x, y] = a < b ? [a, b] : [b, a];
    const k = [m.pool_id ?? 'null', m.round_number ?? 'null', x, y, m.ref_team_id ?? 'null'].join('|');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

async function loadMatches() {
  if (!session.tournament) {
    matches.value = [];
    return;
  }

  const { data, error } = await supabase
    .from('matches')
    .select('id,pool_id,round_number,team1_id,team2_id,ref_team_id,team1_score,team2_score,winner_id,match_type')
    .eq('tournament_id', session.tournament.id)
    .eq('match_type', 'pool')
    .order('pool_id', { ascending: true })
    .order('round_number', { ascending: true })
    .order('id', { ascending: true });

  if (error) {
    toast.add({ severity: 'error', summary: 'Failed to load matches', detail: error.message, life: 3000 });
    matches.value = [];
    return;
  }

  matches.value = dedupePoolMatches(((data as Match[]) ?? []));
}

function computeStandings() {
  const base: Record<string, Standing> = {};
  for (const t of teams.value) {
    base[t.id] = {
      teamId: t.id,
      name: t.full_team_name,
      wins: 0,
      losses: 0,
      played: 0,
      setWon: 0,
      setLost: 0,
      setRatio: 0,
      pointsFor: 0,
      pointsAgainst: 0,
      pointDiff: 0,
      seed: t.seed_global ?? null,
    };
  }

  for (const m of matches.value) {
    const completed = m.team1_score != null && m.team2_score != null;
    if (!completed) continue;
    const t1 = m.team1_id;
    const t2 = m.team2_id;
    if (!t1 || !t2) continue;

    const s1 = m.team1_score ?? 0;
    const s2 = m.team2_score ?? 0;
    const t1Won = s1 > s2 || (s1 === s2 ? m.winner_id === t1 : false);
    const t2Won = s2 > s1 || (s1 === s2 ? m.winner_id === t2 : false);

    if (base[t1]) {
      base[t1].played += 1;
      base[t1].pointsFor += s1;
      base[t1].pointsAgainst += s2;
      base[t1].pointDiff += (s1 - s2);
      if (t1Won) {
        base[t1].wins += 1;
        base[t1].setWon += 1;
      } else if (t2Won) {
        base[t1].losses += 1;
        base[t1].setLost += 1;
      }
    }
    if (base[t2]) {
      base[t2].played += 1;
      base[t2].pointsFor += s2;
      base[t2].pointsAgainst += s1;
      base[t2].pointDiff += (s2 - s1);
      if (t2Won) {
        base[t2].wins += 1;
        base[t2].setWon += 1;
      } else if (t1Won) {
        base[t2].losses += 1;
        base[t2].setLost += 1;
      }
    }
  }

  for (const id of Object.keys(base)) {
    const st = base[id];
    const setsTotal = st.setWon + st.setLost;
    st.setRatio = setsTotal > 0 ? st.setWon / setsTotal : 0;
  }

  const arr = Object.values(base);
  arr.sort((a, b) => {
    if (b.wins !== a.wins) return b.wins - a.wins;
    if (b.setRatio !== a.setRatio) return b.setRatio - a.setRatio;
    if (b.pointDiff !== a.pointDiff) return b.pointDiff - a.pointDiff;
    if (a.seed != null && b.seed != null && a.seed !== b.seed) return a.seed - b.seed;
    return a.name.localeCompare(b.name);
  });

  standings.value = arr;
}

async function subscribeRealtime() {
  if (!session.tournament) return;
  if (channel) {
    await channel.unsubscribe();
    channel = null;
  }
  channel = supabase
    .channel('global_leaderboard_' + session.tournament.id)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'matches', filter: `tournament_id=eq.${session.tournament.id}` },
      async (payload) => {
        const row = (payload.new ?? payload.old) as Match;
        if (row.match_type === 'pool') {
          await loadMatches();
          computeStandings();
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
    computeStandings();
    await subscribeRealtime();
    refreshTimer = setInterval(() => {
      void loadMatches().then(() => computeStandings());
    }, 15_000);
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
  <PublicLayout>
    <section class="p-5 sm:p-7">
      <div class="flex items-center justify-between gap-3">
        <div>
          <h2 class="text-2xl font-semibold text-white">Global Leaderboard</h2>
          <p class="mt-1 text-white/80">
            Tournament-wide pool play standings.
          </p>
        </div>
        <div v-if="loading" class="text-sm text-white/80">Loading…</div>
      </div>

      <div class="mt-6">
        <div v-if="standings.length === 0" class="text-sm text-white/80">No results yet.</div>
        <ul v-else class="mt-3 grid gap-3">
          <li
            v-for="(s, i) in standings"
            :key="s.teamId"
            class="rounded-xl bg-white/10 ring-1 ring-white/20 p-4 text-white"
          >
            <div class="flex items-start gap-3">
              <div
                class="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/10 ring-1 ring-white/20 text-sm font-semibold text-white/90 tabular-nums"
              >
                {{ i + 1 }}
              </div>

              <div class="min-w-0 flex-1">
                <div class="flex items-start justify-between gap-3">
                  <div class="min-w-0 flex-1">
                    <div class="font-semibold text-white leading-tight">
                      {{ s.name }}
                    </div>
                  </div>
                  <div class="shrink-0 text-sm text-white/80 tabular-nums">
                    {{ s.wins }}-{{ s.losses }}
                  </div>
                </div>

                <div class="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-white/70">
                  <span>Global Seed: {{ s.seed ?? '—' }}</span>
                  <span>Set Ratio: {{ (s.setRatio * 100).toFixed(0) }}%</span>
                  <span>Pt Diff: {{ s.pointDiff > 0 ? '+' + s.pointDiff : s.pointDiff }}</span>
                </div>
              </div>
            </div>
          </li>
        </ul>
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
