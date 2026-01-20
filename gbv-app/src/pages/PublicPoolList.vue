<script setup lang="ts">
import { onMounted, ref, computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useToast } from 'primevue/usetoast';
import supabase from '../lib/supabase';
import { useSessionStore } from '../stores/session';
import PublicLayout from '../components/layout/PublicLayout.vue';

type Pool = {
  id: string;
  tournament_id: string;
  name: string;
  court_assignment: string | null;
};

type TeamSeed = {
  id: string;
  pool_id: string | null;
  seed_in_pool: number | null;
  seeded_player_name: string;
};

const route = useRoute();
const router = useRouter();
const toast = useToast();
const session = useSessionStore();

const accessCode = computed(() => (route.params.accessCode as string) ?? session.accessCode ?? '');
const loading = ref(false);
const pools = ref<Pool[]>([]);
const seededFirstNamesByPoolId = ref<Record<string, string[]>>({});

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

async function loadPools() {
  if (!session.tournament) {
    pools.value = [];
    return;
  }
  const { data, error } = await supabase
    .from('pools')
    .select('*')
    .eq('tournament_id', session.tournament.id)
    .order('name', { ascending: true });

  if (error) {
    toast.add({ severity: 'error', summary: 'Failed to load pools', detail: error.message, life: 3000 });
    pools.value = [];
    return;
  }
  pools.value = (data as Pool[]) ?? [];
}

function firstNameFromFullName(name: string): string {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return '';
  const parts = trimmed.split(/\s+/);
  return parts[0] ?? '';
}

async function loadSeededPlayersForPools() {
  if (!session.tournament || pools.value.length === 0) {
    seededFirstNamesByPoolId.value = {};
    return;
  }

  const poolIds = pools.value.map((p) => p.id).filter(Boolean);
  if (poolIds.length === 0) {
    seededFirstNamesByPoolId.value = {};
    return;
  }

  const { data, error } = await supabase
    .from('teams')
    .select('id,pool_id,seed_in_pool,seeded_player_name')
    .eq('tournament_id', session.tournament.id)
    .in('pool_id', poolIds)
    .order('seed_in_pool', { ascending: true });

  if (error) {
    seededFirstNamesByPoolId.value = {};
    return;
  }

  const byPool: Record<string, TeamSeed[]> = {};
  for (const t of ((data as TeamSeed[]) ?? [])) {
    if (!t.pool_id) continue;
    if (t.seed_in_pool == null) continue;
    (byPool[t.pool_id] ??= []).push(t);
  }

  const res: Record<string, string[]> = {};
  for (const [pid, arr] of Object.entries(byPool)) {
    arr.sort((a, b) => (a.seed_in_pool ?? 9999) - (b.seed_in_pool ?? 9999));
    const names = arr
      .map((t) => firstNameFromFullName(t.seeded_player_name))
      .filter(Boolean);
    res[pid] = names;
  }
  seededFirstNamesByPoolId.value = res;
}

function openPool(poolId: string) {
  router.push({ name: 'public-pool-details', params: { accessCode: accessCode.value, poolId } });
}

onMounted(async () => {
  if (accessCode.value) session.setAccessCode(accessCode.value);
  loading.value = true;
  try {
    await ensureTournament();
    await loadPools();
    await loadSeededPlayersForPools();
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <PublicLayout>
    <section class="p-5 sm:p-7">
        <div class="flex items-center justify-between gap-3">
          <div>
            <h2 class="text-2xl font-semibold text-white">Pools</h2>
            <p class="mt-1 text-white/80">
              Choose a pool to view standings and schedule.
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

        <div class="mt-6">
          <div v-if="pools.length === 0" class="text-sm text-white/80">
            No pools yet.
          </div>
          <ul v-else class="grid gap-3 sm:grid-cols-2">
            <li
              v-for="p in pools"
              :key="p.id"
              class="cursor-pointer rounded-xl bg-white/10 ring-1 ring-white/20 p-4 hover:bg-white/15 transition-colors text-white"
              @click="openPool(p.id)"
            >
              <div class="font-semibold">{{ p.name }}</div>
              <div class="text-sm text-white/80">Court: {{ p.court_assignment || 'TBD' }}</div>
              <div v-if="seededFirstNamesByPoolId[p.id]?.length" class="mt-1 text-xs text-white/70">
                Players: <span class="font-medium text-white/80">{{ seededFirstNamesByPoolId[p.id].join(', ') }}</span>
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
