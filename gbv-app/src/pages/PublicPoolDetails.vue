<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useToast } from 'primevue/usetoast';
import supabase from '../lib/supabase';
import { useSessionStore } from '../stores/session';
import PublicLayout from '../components/layout/PublicLayout.vue';

type UUID = string;

type Pool = {
  id: UUID;
  tournament_id: UUID;
  name: string;
  court_assignment: string | null;
};

type Team = {
  id: UUID;
  full_team_name: string;
  seed_in_pool: number | null;
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
  is_live: boolean;
  match_type: 'pool' | 'bracket';
};

const route = useRoute();
const router = useRouter();
const toast = useToast();
const session = useSessionStore();

const accessCode = computed(() => (route.params.accessCode as string) ?? session.accessCode ?? '');
const poolId = computed(() => route.params.poolId as string);

const loading = ref(false);
const pool = ref<Pool | null>(null);
const teams = ref<Team[]>([]);
const teamById = ref<Record<string, Team>>({});
const matches = ref<Match[]>([]);

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

const standings = ref<Standing[]>([]);

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

async function loadPool() {
  if (!session.tournament || !poolId.value) {
    pool.value = null;
    return;
  }
  const { data, error } = await supabase
    .from('pools')
    .select('*')
    .eq('id', poolId.value)
    .eq('tournament_id', session.tournament.id)
    .single();

  if (error || !data) {
    toast.add({ severity: 'error', summary: 'Failed to load pool', detail: error?.message ?? 'Not found', life: 3000 });
    pool.value = null;
    return;
  }
  pool.value = data as Pool;
}

async function loadTeams() {
  if (!session.tournament || !poolId.value) {
    teams.value = [];
    teamById.value = {};
    return;
  }
  const { data, error } = await supabase
    .from('teams')
    .select('id, full_team_name, seed_in_pool')
    .eq('tournament_id', session.tournament.id)
    .eq('pool_id', poolId.value);

  if (error) {
    toast.add({ severity: 'error', summary: 'Failed to load teams', detail: error.message, life: 3000 });
    teams.value = [];
    teamById.value = {};
    return;
  }
  const arr = (data as Team[]) ?? [];
  teams.value = arr;
  const map: Record<string, Team> = {};
  arr.forEach((t) => (map[t.id] = t));
  teamById.value = map;
}

async function loadMatches() {
  if (!session.tournament || !poolId.value) {
    matches.value = [];
    return;
  }
  const { data, error } = await supabase
    .from('matches')
    .select('id,pool_id,round_number,team1_id,team2_id,ref_team_id,team1_score,team2_score,winner_id,is_live,match_type')
    .eq('tournament_id', session.tournament.id)
    .eq('match_type', 'pool')
    .eq('pool_id', poolId.value)
    .order('round_number', { ascending: true })
    .order('id', { ascending: true });

  if (error) {
    toast.add({ severity: 'error', summary: 'Failed to load matches', detail: error.message, life: 3000 });
    matches.value = [];
    return;
  }
  matches.value = (data as Match[]) ?? [];
}

function computeStandings() {
  // Initialize map
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
      seed: t.seed_in_pool ?? null,
    };
  }

  // Aggregate from completed matches (scores not null)
  for (const m of matches.value) {
    const completed = m.team1_score != null && m.team2_score != null;
    if (!completed) continue;
    const t1 = m.team1_id;
    const t2 = m.team2_id;
    if (!t1 || !t2) continue;

    const s1 = m.team1_score ?? 0;
    const s2 = m.team2_score ?? 0;

    if (base[t1]) {
      base[t1].played += 1;
      base[t1].pointsFor += s1;
      base[t1].pointsAgainst += s2;
      base[t1].pointDiff += (s1 - s2);
      if (m.winner_id === t1) {
        base[t1].wins += 1;
        base[t1].setWon += 1;
      } else {
        base[t1].losses += 1;
        base[t1].setLost += 1;
      }
    }
    if (base[t2]) {
      base[t2].played += 1;
      base[t2].pointsFor += s2;
      base[t2].pointsAgainst += s1;
      base[t2].pointDiff += (s2 - s1);
      if (m.winner_id === t2) {
        base[t2].wins += 1;
        base[t2].setWon += 1;
      } else {
        base[t2].losses += 1;
        base[t2].setLost += 1;
      }
    }
  }

  // Set ratios
  for (const id of Object.keys(base)) {
    const st = base[id];
    const setsTotal = st.setWon + st.setLost;
    st.setRatio = setsTotal > 0 ? st.setWon / setsTotal : 0;
  }

  // Helper: head-to-head comparison for exactly two-team ties
  function headToHead(aId: string, bId: string): number {
    // find their direct match if completed
    const direct = matches.value.find((m) => {
      const pair = new Set([m.team1_id, m.team2_id]);
      return pair.has(aId) && pair.has(bId) && m.team1_score != null && m.team2_score != null;
    });
    if (!direct) return 0;
    if (direct.winner_id === aId) return -1; // a above b
    if (direct.winner_id === bId) return 1;  // b above a
    return 0;
  }

  const arr = Object.values(base);

  arr.sort((a, b) => {
    // 1) wins desc
    if (b.wins !== a.wins) return b.wins - a.wins;

    // 2) head-to-head if exactly two-way tie
    const tiedSameWins = arr.filter((x) => x.wins === a.wins);
    if (tiedSameWins.length >= 2) {
      // if only a and b in this tie group, use head-to-head
      const groupAB = tiedSameWins.filter((x) => x.teamId === a.teamId || x.teamId === b.teamId);
      if (groupAB.length === 2) {
        const h2h = headToHead(a.teamId, b.teamId);
        if (h2h !== 0) return h2h;
      }
    }

    // 3) set ratio desc
    if (b.setRatio !== a.setRatio) return b.setRatio - a.setRatio;

    // 4) point diff desc
    if (b.pointDiff !== a.pointDiff) return b.pointDiff - a.pointDiff;

    // 5) seed asc if both available (earlier seed better)
    if (a.seed != null && b.seed != null && a.seed !== b.seed) return a.seed - b.seed;

    // 6) name asc as final fallback
    return a.name.localeCompare(b.name);
  });

  standings.value = arr;
}

function nameFor(id: string | null) {
  if (!id) return 'TBD';
  return teamById.value[id]?.full_team_name ?? 'TBD';
}


function openMatch(matchId: string) {
  router.push({ name: 'match-actions', params: { accessCode: accessCode.value, matchId } });
}

// Realtime subscription to reflect score/live changes
let channel: ReturnType<typeof supabase.channel> | null = null;

async function subscribeRealtime() {
  if (!session.tournament) return;
  if (channel) {
    await channel.unsubscribe();
    channel = null;
  }
  channel = supabase
    .channel('pool_matches_' + session.tournament.id + '_' + poolId.value)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'matches',
        filter: `tournament_id=eq.${session.tournament.id}`,
      },
      async (payload) => {
        const row = (payload.new ?? payload.old) as Match;
        if (row.pool_id === poolId.value && row.match_type === 'pool') {
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
    await loadPool();
    await loadTeams();
    await loadMatches();
    computeStandings();
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
            <h2 class="text-2xl font-semibold text-white">
              {{ pool?.name || 'Pool' }}
            </h2>
            <p class="mt-1 text-white/80">
              Court: <span class="font-medium">{{ pool?.court_assignment || 'TBD' }}</span>
            </p>
          </div>
          <div v-if="loading" class="text-sm text-white/80">Loading…</div>
        </div>

        <!-- Standings -->
        <div class="mt-6">
          <h3 class="text-lg font-semibold text-white">Standings</h3>
          <div v-if="standings.length === 0" class="mt-2 text-sm text-white/80">No results yet.</div>
          <div v-else class="mt-3 overflow-x-auto">
            <table class="min-w-full border-separate border-spacing-y-2">
              <thead class="text-left text-sm text-white/80">
                <tr>
                  <th class="px-3 py-1">#</th>
                  <th class="px-3 py-1">Team</th>
                  <th class="px-3 py-1">W</th>
                  <th class="px-3 py-1">L</th>
                  <th class="px-3 py-1">Sets</th>
                  <th class="px-3 py-1">Set %</th>
                  <th class="px-3 py-1">Pt Diff</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(s, i) in standings" :key="s.teamId" class="rounded-xl">
                  <td class="px-3 py-2 text-white">{{ i + 1 }}</td>
                  <td class="px-3 py-2">
                    <div class="font-medium text-white">{{ s.name }}</div>
                    <div v-if="s.seed != null" class="text-xs text-white/70">Seed: {{ s.seed }}</div>
                  </td>
                  <td class="px-3 py-2 text-white">{{ s.wins }}</td>
                  <td class="px-3 py-2 text-white">{{ s.losses }}</td>
                  <td class="px-3 py-2 text-white">{{ s.setWon }}-{{ s.setLost }}</td>
                  <td class="px-3 py-2 text-white">{{ (s.setRatio * 100).toFixed(0) }}%</td>
                  <td class="px-3 py-2 text-white">{{ s.pointDiff > 0 ? '+' + s.pointDiff : s.pointDiff }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- Schedule -->
        <div class="mt-8">
          <h3 class="text-lg font-semibold text-white">Schedule</h3>
          <div v-if="matches.length === 0" class="mt-2 text-sm text-white/80">No matches scheduled.</div>
          <ul v-else class="mt-3 grid gap-3">
            <li
              v-for="m in matches"
              :key="m.id"
              class="cursor-pointer rounded-xl bg-white/10 ring-1 ring-white/20 p-4 hover:bg-white/15 transition-colors text-white"
              @click="openMatch(m.id)"
            >
              <div class="flex items-center justify-between">
                <div class="text-sm text-white/80">
                  Round {{ m.round_number ?? '—' }}
                </div>
              </div>
              <div class="mt-1 font-semibold text-white">
                {{ nameFor(m.team1_id) }} vs {{ nameFor(m.team2_id) }}
              </div>
              <div class="mt-1 text-xs text-white/70">
                Ref: {{ nameFor(m.ref_team_id) }}
              </div>
            </li>
          </ul>
        </div>

        <div class="mt-8 text-sm text-white/80 text-center">
          Back to
          <router-link class="underline" :to="{ name: 'public-pool-list', params: { accessCode } }">
            Pools
          </router-link>
        </div>
    </section>
  </PublicLayout>
</template>