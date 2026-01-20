<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useToast } from 'primevue/usetoast';
import InputText from 'primevue/inputtext';
import Dropdown from 'primevue/dropdown';
import Button from 'primevue/button';
import supabase from '../lib/supabase';
import { useSessionStore } from '../stores/session';
import UiSectionHeading from '@/components/ui/UiSectionHeading.vue';
import UiAccordion from '@/components/ui/UiAccordion.vue';

type Pool = {
  id: string;
  name: string;
  court_assignment: string | null;
  target_size: number | null;
};

type Team = {
  id: string;
  seeded_player_name: string;
  pool_id: string | null;
  seed_in_pool: number | null;
  seed_global: number | null;
};

const router = useRouter();
const toast = useToast();
const session = useSessionStore();

const accessCode = ref<string>(session.accessCode ?? '');
const loading = ref(false);
const saving = ref(false);
const generating = ref(false);

// Data
const pools = ref<Pool[]>([]);
const teams = ref<Team[]>([]);

// Local pool edit buffers
const selectedPoolId = ref<string | null>(null);
const editPoolName = ref<string>('');
const editCourt = ref<string>('');
const newPoolName = ref<string>('');
const newPoolCourt = ref<string>('');

// Pool size options (only 4–5 supported)
const poolSizeOptions = [4, 5].map((n) => ({ label: `${n} teams`, value: n }));
const newPoolSize = ref<number | null>(null);

// Derived
const selectedPool = computed(() => pools.value.find((p) => p.id === selectedPoolId.value) || null);

const unassignedTeams = computed(() => {
  return teams.value
    .filter((t) => !t.pool_id)
    .slice()
    .sort((a, b) => a.seeded_player_name.localeCompare(b.seeded_player_name));
});

function teamsForPool(poolId: string) {
  return teams.value
    .filter((t) => t.pool_id === poolId)
    .slice()
    .sort((a, b) => {
      const sa = a.seed_in_pool ?? 9999;
      const sb = b.seed_in_pool ?? 9999;
      if (sa !== sb) return sa - sb;
      return a.seeded_player_name.localeCompare(b.seeded_player_name);
    });
}

function poolHasSeedConflicts(poolId: string) {
  const arr = teamsForPool(poolId).map((t) => t.seed_in_pool).filter((n) => n != null) as number[];
  const seen = new Set<number>();
  for (const n of arr) {
    if (seen.has(n)) return true;
    seen.add(n);
  }
  return false;
}

const moveOptions = computed(() => {
  return [
    { label: 'Unassigned', value: null },
    ...pools.value.map((p) => ({ label: `${p.name}${p.court_assignment ? ` — Court ${p.court_assignment}` : ''}`, value: p.id }))
  ];
});

/**
 * Migration assistance: flag pools that are not size 4 or 5.
 */
const teamCountsByPool = computed(() => {
  const m = new Map<string, number>();
  for (const t of teams.value) {
    if (t.pool_id) m.set(t.pool_id, (m.get(t.pool_id) ?? 0) + 1);
  }
  return m;
});

const invalidPools = computed(() => {
  return pools.value
    .map((p) => ({ pool: p, size: teamCountsByPool.value.get(p.id) ?? 0 }))
    .filter((x) => x.size !== 0 && x.size !== 4 && x.size !== 5);
});

const poolsMissingSeeds = computed(() => {
  return pools.value
    .map((p) => {
      const poolTeams = teams.value.filter((t) => t.pool_id === p.id);
      const missing = poolTeams.filter((t) => t.seed_in_pool == null).length;
      return { pool: p, size: poolTeams.length, missing };
    })
    .filter((x) => x.size > 0 && x.missing > 0);
});

// Loaders
async function loadTournamentByAccessCode() {
  if (!accessCode.value?.trim()) {
    toast.add({ severity: 'warn', summary: 'Access code required', life: 2000 });
    return;
  }
  loading.value = true;
  try {
    await session.ensureAnon();
    session.setAccessCode(accessCode.value.trim());
    const t = await session.loadTournamentByCode(accessCode.value.trim());
    if (!t) {
      toast.add({ severity: 'error', summary: 'Tournament not found', life: 2500 });
      pools.value = [];
      teams.value = [];
      return;
    }
    toast.add({ severity: 'success', summary: 'Tournament loaded', detail: t.name, life: 1500 });
    await Promise.all([loadPools(), loadTeams()]);
  } finally {
    loading.value = false;
  }
}

async function loadPools() {
  if (!session.tournament) return;
  const { data, error } = await supabase
    .from('pools')
    .select('id,name,court_assignment,target_size')
    .eq('tournament_id', session.tournament.id)
    .order('name', { ascending: true });
  if (error) {
    toast.add({ severity: 'error', summary: 'Failed to load pools', detail: error.message, life: 2500 });
    pools.value = [];
    return;
  }
  pools.value = (data || []) as Pool[];
  // maintain selection
  if (selectedPoolId.value && !pools.value.find((p) => p.id === selectedPoolId.value)) {
    selectedPoolId.value = null;
  }
  if (!selectedPoolId.value && pools.value.length > 0) {
    selectPool(pools.value[0]);
  }
}

async function loadTeams() {
  if (!session.tournament) return;
  const { data, error } = await supabase
    .from('teams')
    .select('id,seeded_player_name,pool_id,seed_in_pool,seed_global')
    .eq('tournament_id', session.tournament.id);
  if (error) {
    toast.add({ severity: 'error', summary: 'Failed to load teams', detail: error.message, life: 2500 });
    teams.value = [];
    return;
  }
  teams.value = (data || []) as Team[];
}
 
onMounted(async () => {
  try {
    await session.ensureAnon();
    session.initFromStorage();

    // If a tournament is already loaded, fetch data
    if (session.tournament) {
      loading.value = true;
      try {
        await Promise.all([loadPools(), loadTeams()]);
      } finally {
        loading.value = false;
      }
      return;
    }

    // Attempt to restore by stored access code
    if (session.accessCode) {
      loading.value = true;
      try {
        const t = await session.loadTournamentByCode(session.accessCode);
        if (t) {
          await Promise.all([loadPools(), loadTeams()]);
          toast.add({ severity: 'info', summary: 'Tournament restored', detail: t.name, life: 1200 });
        }
      } finally {
        loading.value = false;
      }
    }
  } catch {
    // ignore restore errors; user can load via access code
  }
});
 
// Pool CRUD
function selectPool(p: Pool) {
  selectedPoolId.value = p.id;
  editPoolName.value = p.name;
  editCourt.value = p.court_assignment ?? '';
}

async function createPool() {
  if (!session.tournament) return;
  const name = (newPoolName.value || '').trim();
  if (!name) {
    toast.add({ severity: 'warn', summary: 'Pool name required', life: 2000 });
    return;
  }
  if (!newPoolSize.value || ![4, 5].includes(Number(newPoolSize.value))) {
    toast.add({ severity: 'warn', summary: 'Select a pool size (4 or 5)', life: 2000 });
    return;
  }
  saving.value = true;
  try {
    const { error } = await supabase.from('pools').insert({
      tournament_id: session.tournament.id,
      name,
      court_assignment: newPoolCourt.value ? newPoolCourt.value.trim() : null,
      target_size: newPoolSize.value,
    });
    if (error) throw error;
    toast.add({ severity: 'success', summary: 'Pool created', life: 1200 });
    newPoolName.value = '';
    newPoolCourt.value = '';
    newPoolSize.value = null;
    await loadPools();
  } catch (err: any) {
    toast.add({ severity: 'error', summary: 'Create failed', detail: err?.message ?? 'Unknown error', life: 3000 });
  } finally {
    saving.value = false;
  }
}

async function saveSelectedPool() {
  if (!session.tournament || !selectedPool.value) return;
  const name = editPoolName.value.trim();
  if (!name) {
    toast.add({ severity: 'warn', summary: 'Pool name required', life: 2000 });
    return;
  }
  saving.value = true;
  try {
    const { error } = await supabase
      .from('pools')
      .update({
        name,
        court_assignment: editCourt.value.trim() || null,
      })
      .eq('id', selectedPool.value.id);
    if (error) throw error;
    toast.add({ severity: 'success', summary: 'Pool saved', life: 1200 });
    await loadPools();
  } catch (err: any) {
    toast.add({ severity: 'error', summary: 'Save failed', detail: err?.message ?? 'Unknown error', life: 3000 });
  } finally {
    saving.value = false;
  }
}

async function deleteSelectedPool() {
  if (!selectedPool.value) return;
  const ok = confirm(`Delete pool "${selectedPool.value.name}"? Teams will become unassigned.`);
  if (!ok) return;
  saving.value = true;
  try {
    const { error } = await supabase.from('pools').delete().eq('id', selectedPool.value.id);
    if (error) throw error;
    toast.add({ severity: 'success', summary: 'Pool deleted', life: 1200 });
    selectedPoolId.value = null;
    await Promise.all([loadPools(), loadTeams()]);
  } catch (err: any) {
    toast.add({ severity: 'error', summary: 'Delete failed', detail: err?.message ?? 'Unknown error', life: 3000 });
  } finally {
    saving.value = false;
  }
}

// Move & Seed flows (no drag-and-drop)
async function moveTeam(teamId: string, targetPoolId: string | null) {
  if (!session.tournament) return;
  try {
    const { error } = await supabase
      .from('teams')
      .update({
        pool_id: targetPoolId,
        seed_in_pool: null, // reset seed on move
      })
      .eq('id', teamId);
    if (error) throw error;
    // local update
    const t = teams.value.find((x) => x.id === teamId);
    if (t) {
      t.pool_id = targetPoolId;
      t.seed_in_pool = null;
    }
  } catch (err: any) {
    toast.add({ severity: 'error', summary: 'Move failed', detail: err?.message ?? 'Unknown error', life: 3000 });
  }
}

async function setSeed(teamId: string, seedStr: string) {
  if (!teamId) return;
  const seed = seedStr ? Number(seedStr) : null;
  if (seed !== null && (!Number.isInteger(seed) || seed < 1)) {
    toast.add({ severity: 'warn', summary: 'Seed must be a positive integer', life: 2000 });
    return;
  }
  try {
    const { error } = await supabase.from('teams').update({ seed_in_pool: seed }).eq('id', teamId);
    if (error) throw error;
    const t = teams.value.find((x) => x.id === teamId);
    if (t) t.seed_in_pool = seed;
  } catch (err: any) {
    toast.add({ severity: 'error', summary: 'Update seed failed', detail: err?.message ?? 'Unknown error', life: 3000 });
  }
}
/**
 * Autogenerate Pools
 * - Prefer pools of 5; sizes must be a combination of 4 and 5 exactly.
 * - Pools named 'Pool {number}', court set to '{number}'.
 * - Teams assigned snake-wise by seed_global (nulls last by name).
 * - Existing pools and pool-play matches will be deleted after confirmation.
 */
async function autogeneratePools() {
  if (!session.tournament) return;
  const tournamentId = session.tournament.id;

  generating.value = true;
  try {
    // Freshly load players ordered by global seed (nulls last, then name)
    const { data: teamRows, error: teamErr } = await supabase
      .from('teams')
      .select('id,seeded_player_name,seed_in_pool,pool_id,seed_global')
      .eq('tournament_id', tournamentId)
      .order('seed_global', { ascending: true })
      .order('seeded_player_name', { ascending: true });

    if (teamErr) throw new Error(`Load teams failed: ${teamErr.message}`);

    const ordered: Team[] = (teamRows as any[]).sort((a, b) => {
      const ag = a.seed_global;
      const bg = b.seed_global;
      if (ag == null && bg == null) return a.seeded_player_name.localeCompare(b.seeded_player_name);
      if (ag == null) return 1;  // nulls last
      if (bg == null) return -1;
      return ag - bg;
    });

    const N = ordered.length;
    if (N === 0) {
      toast.add({ severity: 'warn', summary: 'No players', detail: 'Import players first.', life: 2500 });
      return;
    }

    // Compute pool sizes (prefer 5, allow 4). Block on impossible counts like 6,7,11.
    const sizes = computePoolSizes(N);
    if (!sizes) {
      toast.add({ severity: 'error', summary: 'Cannot partition', detail: `Player count ${N} cannot be partitioned into pools of 4 or 5. Adjust players.`, life: 4000 });
      return;
    }

    // Confirm destructive changes if pools or pool matches exist
    const existingPools = pools.value.length > 0;
    const anyAssigned = teams.value.some(t => t.pool_id);
    const poolMatches = await hasExistingPoolMatches(tournamentId);

    if (existingPools || anyAssigned || poolMatches) {
      const ok = confirm('Autogenerate will delete all existing pools and all pool-play matches, then recreate pools and assignments. Continue?');
      if (!ok) return;

      // Delete matches (pool)
      if (poolMatches) {
        const { error: delMErr } = await supabase
          .from('matches')
          .delete()
          .eq('tournament_id', tournamentId)
          .eq('match_type', 'pool');
        if (delMErr) throw new Error(`Failed to delete pool matches: ${delMErr.message}`);
      }

      // Delete pools (teams will be unassigned via ON DELETE SET NULL)
      if (existingPools) {
        const { error: delPErr } = await supabase
          .from('pools')
          .delete()
          .eq('tournament_id', tournamentId);
        if (delPErr) throw new Error(`Failed to delete pools: ${delPErr.message}`);
      }

      // Ensure seed_in_pool reset (clean slate)
      const { error: clrErr } = await supabase
        .from('teams')
        .update({ seed_in_pool: null, pool_id: null })
        .eq('tournament_id', tournamentId);
      if (clrErr) throw new Error(`Failed to reset team assignments: ${clrErr.message}`);

      // Refresh local caches
      await Promise.all([loadPools(), loadTeams()]);
    }

    // Create new pools
    const targetPayload = sizes.map((sz, i) => ({
      tournament_id: tournamentId,
      name: `Pool ${i + 1}`,
      court_assignment: String(i + 1),
      target_size: sz,
    }));

    const { data: createdPools, error: insPErr } = await supabase
      .from('pools')
      .insert(targetPayload)
      .select('id,name,target_size,court_assignment');

    if (insPErr) throw new Error(`Failed to create pools: ${insPErr.message}`);

    // Ensure same order as sizes (Pool 1..Pool P)
    const createdOrdered = (createdPools as any[]).slice().sort((a, b) => {
      const ai = Number(String(a.name).replace(/[^0-9]/g, '') || '0');
      const bi = Number(String(b.name).replace(/[^0-9]/g, '') || '0');
      return ai - bi;
    });

    // Snake distribution respecting capacities
    const poolCap = createdOrdered.map(p => Number(p.target_size) || 0);
    const poolAssigned: number[] = createdOrdered.map(() => 0);
    let dir: 1 | -1 = 1;
    let idx = 0;
    const P = createdOrdered.length;

    // Helper to advance idx in snake pattern
    function advance() {
      if (P === 1) return;
      if (dir === 1) {
        if (idx >= P - 1) { dir = -1; idx = P - 2; }
        else idx += 1;
      } else {
        if (idx <= 0) { dir = 1; idx = 1; }
        else idx -= 1;
      }
    }

    // Assignments to perform (per-team update)
    type Assign = { id: string; pool_id: string; seed_in_pool: number };
    const assigns: Assign[] = [];

    for (const t of ordered) {
      // Find next available pool slot following snake, skipping full pools
      let attempts = 0;
      while (attempts < P * 2 && poolAssigned[idx] >= poolCap[idx]) {
        advance();
        attempts++;
      }
      if (poolAssigned[idx] >= poolCap[idx]) {
        // fallback linear scan
        let found = -1;
        for (let j = 0; j < P; j++) {
          if (poolAssigned[j] < poolCap[j]) { found = j; break; }
        }
        if (found === -1) {
          throw new Error('Internal: capacity overflow while assigning teams.');
        }
        idx = found;
      }

      const pool = createdOrdered[idx];
      const seedInPool = poolAssigned[idx] + 1;
      assigns.push({ id: t.id, pool_id: pool.id, seed_in_pool: seedInPool });
      poolAssigned[idx] += 1;

      // move to next slot in snake
      advance();
    }

    // Persist assignments (per-row updates)
    for (const a of assigns) {
      const { error: upErr } = await supabase
        .from('teams')
        .update({ pool_id: a.pool_id, seed_in_pool: a.seed_in_pool })
        .eq('id', a.id);
      if (upErr) throw new Error(`Failed to assign team: ${upErr.message}`);
    }

    await Promise.all([loadPools(), loadTeams()]);
    toast.add({ severity: 'success', summary: `Created ${createdOrdered.length} pool(s) and assigned ${assigns.length} team(s)`, life: 2500 });
  } catch (err: any) {
    toast.add({ severity: 'error', summary: 'Autogenerate failed', detail: err?.message ?? 'Unknown error', life: 4000 });
  } finally {
    generating.value = false;
  }
}

// Return array of pool sizes (5s then 4s) or null if impossible
function computePoolSizes(n: number): number[] | null {
  // Try max number of 5s, reduce until remainder divisible by 4
  for (let fives = Math.floor(n / 5); fives >= 0; fives--) {
    const rem = n - fives * 5;
    if (rem === 0) {
      return Array(fives).fill(5);
    }
    if (rem > 0 && rem % 4 === 0) {
      const fours = rem / 4;
      return Array(fives).fill(5).concat(Array(fours).fill(4));
    }
  }
  return null;
}

async function hasExistingPoolMatches(tournamentId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('matches')
    .select('id', { head: false, count: 'exact' })
    .eq('tournament_id', tournamentId)
    .eq('match_type', 'pool')
    .limit(1);
  if (error) return false;
  return Array.isArray(data) && data.length > 0;
}
</script>

<template>
  <section class="mx-auto max-w-7xl px-4 py-6">
    <UiSectionHeading
      title="Pools & Seeds"
      subtitle="Create pools, assign teams using Move, and set unique seeds per pool."
      :divider="true"
    >
      
        <Button
          label="Back"
          icon="pi pi-arrow-left"
          severity="secondary"
          outlined
          class="!rounded-xl !border-white/40 !text-white hover:!bg-white/10"
          @click="router.push({ name: 'admin-dashboard' })"
        />
      
    </UiSectionHeading>

    <!-- Tournament loader -->
    <div class="rounded-lg border border-white/15 bg-white/5 p-4">
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end" v-if="!session.tournament">
        <div class="sm:col-span-2">
          <label class="block text-sm mb-2">Tournament Access Code</label>
          <InputText
            v-model="accessCode"
            placeholder="e.g. GATORS2025"
            class="w-full !rounded-xl !px-4 !py-3 !bg-white !text-slate-900"
          />
        </div>
        <div class="flex">
          <Button
            :loading="loading"
            label="Load Tournament"
            icon="pi pi-search"
            class="!rounded-xl !px-4 !py-3 border-none text-white gbv-grad-blue"
            @click="loadTournamentByAccessCode"
          />
        </div>
      </div>
      <div v-else class="text-sm">
        Loaded:
        <span class="font-semibold">{{ session.tournament.name }}</span>
        <span class="ml-2 text-white/80">({{ session.accessCode }})</span>
      </div>
    </div>

    <!-- Autogenerate Pools -->
    <div v-if="session.tournament" class="mt-4 rounded-lg border border-white/15 bg-white/5 p-4">
      <div class="flex items-center justify-between">
        <div class="text-sm">
          <div class="font-semibold">Autogenerate Pools</div>
          <div class="mt-1 text-white/80">
            Creates pools of size 4 or 5 (prefers 5) from global seeds, assigns courts, and seeds within pools using snake distribution.
          </div>
        </div>
        <Button
          :loading="generating"
          label="Autogenerate"
          icon="pi pi-cog"
          class="!rounded-xl border-none text-white gbv-grad-green"
          @click="autogeneratePools"
        />
      </div>
    </div>

    <!-- Migration assistance: warn about unsupported pool sizes -->
    <div
      v-if="invalidPools.length > 0"
      class="mt-4 rounded-lg border border-amber-300 bg-amber-400/10 p-4 text-amber-100 text-sm"
    >
      <div class="font-semibold mb-1">Unsupported pool sizes detected</div>
      <ul class="list-disc list-inside">
        <li v-for="ip in invalidPools" :key="ip.pool.id">
          {{ ip.pool.name }} has {{ ip.size }} team(s). Adjust to 4 or 5 before generating the schedule.
        </li>
      </ul>
    </div>

    <div
      v-if="poolsMissingSeeds.length > 0"
      class="mt-4 rounded-lg border border-amber-300 bg-amber-400/10 p-4 text-amber-100 text-sm"
    >
      <div class="font-semibold mb-1">Missing pool seeds detected</div>
      <ul class="list-disc list-inside">
        <li v-for="ms in poolsMissingSeeds" :key="ms.pool.id">
          {{ ms.pool.name }} has {{ ms.missing }} team(s) without a seed.
        </li>
      </ul>
      <div class="mt-2 text-xs text-white/80">Schedule generation will be blocked until every team in a pool has a seed.</div>
    </div>

    <div v-if="session.tournament" class="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
      <!-- Left: Pools and editor -->
      <div class="lg:col-span-1">
        <UiAccordion title="Pools" :defaultOpen="true">
          <div class="flex items-center justify-between">
            <div class="text-xs text-white/80">Total: {{ pools.length }}</div>
          </div>

          <!-- Simple list of pools -->
          <div class="mt-3 rounded-lg border border-white/15 overflow-hidden">
            <button
              v-for="p in pools"
              :key="p.id"
              class="w-full text-left px-4 py-3 border-b border-white/10 last:border-b-0 hover:bg-white/5"
              :class="selectedPoolId === p.id ? 'bg-white/10' : ''"
              @click="selectPool(p)"
            >
              <div class="font-semibold">{{ p.name }}</div>
              <div class="text-xs text-white/80">Court: {{ p.court_assignment || 'TBD' }}</div>
            </button>
          </div>

          <!-- New pool -->
          <div class="mt-4 rounded-lg border border-white/15 bg-white/5 p-4">
            <div class="text-sm font-semibold">New Pool</div>
            <div class="mt-2 grid grid-cols-1 gap-3">
              <InputText v-model="newPoolName" placeholder="e.g. Pool A" class="!rounded-xl !px-4 !py-3 !bg-white !text-slate-900" />
              <InputText v-model="newPoolCourt" placeholder="Court (optional)" class="!rounded-xl !px-4 !py-3 !bg-white !text-slate-900" />
              <Dropdown
                v-model="newPoolSize"
                :options="poolSizeOptions"
                optionLabel="label"
                optionValue="value"
                placeholder="Pool size (4–5)"
                class="!rounded-xl"
              />
              <Button
                :loading="saving"
                label="Create"
                icon="pi pi-plus"
                class="!rounded-xl border-none text-white gbv-grad-blue"
                @click="createPool"
              />
            </div>
          </div>

          <!-- Edit pool -->
          <div v-if="selectedPool" class="mt-4 rounded-lg border border-white/15 bg-white/5 p-4">
            <div class="text-sm font-semibold">Edit Pool</div>
            <div class="mt-2 grid grid-cols-1 gap-3">
              <InputText v-model="editPoolName" placeholder="Pool name" class="!rounded-xl !px-4 !py-3 !bg-white !text-slate-900" />
              <InputText v-model="editCourt" placeholder="Court (optional)" class="!rounded-xl !px-4 !py-3 !bg-white !text-slate-900" />
              <div class="flex items-center gap-2">
                <Button
                  :loading="saving"
                  label="Save"
                  icon="pi pi-save"
                  class="!rounded-xl border-none text-white gbv-grad-blue"
                  @click="saveSelectedPool"
                />
                <Button
                  :loading="saving"
                  label="Delete"
                  icon="pi pi-trash"
                  severity="danger"
                  class="!rounded-xl"
                  @click="deleteSelectedPool"
                />
              </div>
            </div>
            <div
              v-if="selectedPool && poolHasSeedConflicts(selectedPool.id)"
              class="mt-3 rounded-lg border border-amber-300 bg-amber-400/10 p-2 text-xs text-amber-100"
            >
              Warning: Duplicate seeds found in this pool.
            </div>
          </div>
        </UiAccordion>
      </div>

      <!-- Right: Unassigned + Pools accordions -->
      <div class="lg:col-span-2">
        <div class="grid grid-cols-1 gap-6">
          <!-- Unassigned -->
          <UiAccordion title="Unassigned Teams" :defaultOpen="true" subtitle="Move a team into a pool to assign">
            <div class="rounded-lg border border-white/15 overflow-hidden">
              <div
                v-for="t in unassignedTeams"
                :key="t.id"
                class="px-4 py-3 border-b border-white/10 last:border-b-0"
              >
                <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                  <div>
                    <div class="font-medium">{{ t.seeded_player_name }}</div>
                    <div class="text-xs text-white/80">No pool</div>
                  </div>
                  <div class="flex items-center gap-3">
                    <label class="text-sm">Move</label>
                    <Dropdown
                      :options="moveOptions"
                      optionLabel="label"
                      optionValue="value"
                      placeholder="Select pool"
                      class="w-56 !rounded-xl"
                      :pt="{ input: { class: '!py-2 !px-3 !text-sm !rounded-xl' } }"
                      @update:modelValue="(val:any) => moveTeam(t.id, val)"
                    />
                  </div>
                </div>
              </div>
              <div v-if="unassignedTeams.length === 0" class="px-4 py-3 text-sm text-white/80">No teams.</div>
            </div>
          </UiAccordion>

          <!-- Each pool accordion -->
          <div class="grid grid-cols-1 gap-6">
            <UiAccordion
              v-for="p in pools"
              :key="p.id"
              :title="p.name"
              :subtitle="`Court: ${p.court_assignment || 'TBD'}`"
              :defaultOpen="false"
            >
              <div class="flex items-center justify-between">
                <div class="text-xs text-white/80">Drop-down to move teams between pools</div>
                <div
                  v-if="poolHasSeedConflicts(p.id)"
                  class="rounded-full bg-amber-400/20 px-2 py-0.5 text-xs font-semibold text-amber-100"
                  title="Duplicate seeds present"
                >
                  Seed conflict
                </div>
              </div>

              <div class="mt-3 rounded-lg border border-white/15 overflow-hidden">
                <div
                  v-for="t in teamsForPool(p.id)"
                  :key="t.id"
                  class="px-4 py-3 border-b border-white/10 last:border-b-0"
                >
                  <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 items-center">
                    <div>
                      <div class="font-medium">{{ t.seeded_player_name }}</div>
                      <div class="text-xs text-white/80">ID: {{ t.id.slice(0, 8) }}…</div>
                    </div>
                    <div class="flex items-center gap-2">
                      <label class="text-sm">Seed</label>
                      <InputText
                        :value="t.seed_in_pool ?? ''"
                        style="width: 4.5rem"
                        class="!rounded-xl !px-3 !py-2 !bg-white !text-slate-900"
                        placeholder="1"
                        @change="(e:any) => setSeed(t.id, e.target.value)"
                      />
                    </div>
                    <div class="flex items-center gap-3 lg:justify-end">
                      <label class="text-sm">Move</label>
                      <Dropdown
                        :options="moveOptions"
                        optionLabel="label"
                        optionValue="value"
                        :modelValue="t.pool_id"
                        class="w-56 !rounded-xl"
                        :pt="{ input: { class: '!py-2 !px-3 !text-sm !rounded-xl' } }"
                        @update:modelValue="(val:any) => moveTeam(t.id, val)"
                      />
                    </div>
                  </div>
                </div>
                <div v-if="teamsForPool(p.id).length === 0" class="px-4 py-3 text-sm text-white/80">
                  No teams yet.
                </div>
              </div>
            </UiAccordion>
          </div>

          <div class="rounded-lg border border-dashed border-white/25 p-4 text-center text-sm text-white/80">
            Tip: Use the Move menu to change a team's pool. Seeds must be unique within each pool.
          </div>
        </div>
      </div>
    </div>

    <div class="mt-6 text-sm text-white/80">
      Seeds must be unique within each pool. You can leave seeds blank temporarily, but schedule generation requires complete seeding.
    </div>
  </section>
</template>

<style scoped>
</style>
