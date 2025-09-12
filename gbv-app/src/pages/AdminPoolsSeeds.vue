<script setup lang="ts">
import { ref, computed } from 'vue';
import { useRouter } from 'vue-router';
import { useToast } from 'primevue/usetoast';
import InputText from 'primevue/inputtext';
import Button from 'primevue/button';
import DataTable from 'primevue/datatable';
import Column from 'primevue/column';
import supabase from '../lib/supabase';
import { useSessionStore } from '../stores/session';

type Pool = {
  id: string;
  name: string;
  court_assignment: string | null;
};

type Team = {
  id: string;
  seeded_player_name: string;
  pool_id: string | null;
  seed_in_pool: number | null;
};

const router = useRouter();
const toast = useToast();
const session = useSessionStore();

const accessCode = ref<string>(session.accessCode ?? '');
const loading = ref(false);
const saving = ref(false);

// Data
const pools = ref<Pool[]>([]);
const teams = ref<Team[]>([]);

// Local pool edit buffers
const selectedPoolId = ref<string | null>(null);
const editPoolName = ref<string>('');
const editCourt = ref<string>('');
const newPoolName = ref<string>('');
const newPoolCourt = ref<string>('');

// Drag state
const draggingTeamId = ref<string | null>(null);

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
    .select('id,name,court_assignment')
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
    .select('id,seeded_player_name,pool_id,seed_in_pool')
    .eq('tournament_id', session.tournament.id);
  if (error) {
    toast.add({ severity: 'error', summary: 'Failed to load teams', detail: error.message, life: 2500 });
    teams.value = [];
    return;
  }
  teams.value = (data || []) as Team[];
}

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
  saving.value = true;
  try {
    const { error } = await supabase.from('pools').insert({
      tournament_id: session.tournament.id,
      name,
      court_assignment: newPoolCourt.value ? newPoolCourt.value.trim() : null,
    });
    if (error) throw error;
    toast.add({ severity: 'success', summary: 'Pool created', life: 1200 });
    newPoolName.value = '';
    newPoolCourt.value = '';
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

// Drag & Drop
function onDragStartTeam(teamId: string) {
  draggingTeamId.value = teamId;
}

async function onDropToPool(poolId: string | null) {
  if (!session.tournament) return;
  const teamId = draggingTeamId.value;
  draggingTeamId.value = null;
  if (!teamId) return;

  try {
    const { error } = await supabase
      .from('teams')
      .update({
        pool_id: poolId,
        seed_in_pool: null, // reset seed; admin must set within new pool
      })
      .eq('id', teamId);
    if (error) throw error;
    await loadTeams();
  } catch (err: any) {
    toast.add({ severity: 'error', summary: 'Move failed', detail: err?.message ?? 'Unknown error', life: 3000 });
  }
}

function allowDrop(e: DragEvent) {
  e.preventDefault();
}

// Seeding
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
    // Update local shallowly
    const t = teams.value.find((x) => x.id === teamId);
    if (t) t.seed_in_pool = seed;
  } catch (err: any) {
    toast.add({ severity: 'error', summary: 'Update seed failed', detail: err?.message ?? 'Unknown error', life: 3000 });
  }
}
</script>

<template>
  <section class="mx-auto max-w-7xl px-4 pb-10 pt-6">
    <div class="rounded-2xl border border-slate-200 bg-white shadow-lg">
      <div class="p-5 sm:p-7">
        <div class="flex items-center justify-between gap-3">
          <div>
            <h2 class="text-2xl font-semibold text-slate-900">Pools & Seeds</h2>
            <p class="mt-1 text-slate-600">
              Create pools, assign teams via drag-and-drop, and set unique seeds per pool.
            </p>
          </div>
          <Button
            label="Back"
            icon="pi pi-arrow-left"
            severity="secondary"
            outlined
            class="!rounded-xl"
            @click="router.push({ name: 'admin-dashboard' })"
          />
        </div>

        <!-- Tournament loader -->
        <div class="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div class="rounded-xl bg-gbv-bg p-4 sm:col-span-3">
            <div class="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
              <div class="sm:col-span-2">
                <label class="block text-sm font-medium text-slate-700 mb-2">Tournament Access Code</label>
                <InputText
                  v-model="accessCode"
                  placeholder="e.g. GATORS2025"
                  class="w-full !rounded-xl !px-4 !py-3"
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
            <div v-if="session.tournament" class="mt-2 text-sm text-slate-700">
              Loaded: <span class="font-semibold">{{ session.tournament.name }}</span>
            </div>
          </div>
        </div>

        <div v-if="session.tournament" class="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
          <!-- Pools list and editor -->
          <div class="lg:col-span-1">
            <div class="rounded-xl bg-gbv-bg p-4">
              <div class="flex items-center justify-between">
                <h3 class="text-lg font-semibold text-slate-900">Pools</h3>
                <div class="text-xs text-slate-600">Total: {{ pools.length }}</div>
              </div>

              <div class="mt-3">
                <DataTable
                  :value="pools"
                  size="small"
                  class="rounded-xl overflow-hidden"
                  tableClass="!text-sm"
                  selectionMode="single"
                  :metaKeySelection="false"
                  :selection="selectedPoolId ? [selectedPoolId] : []"
                  @row-click="(e:any) => selectPool(e.data)"
                >
                  <Column field="name" header="Name" />
                  <Column field="court_assignment" header="Court" />
                </DataTable>
              </div>

              <div class="mt-4 rounded-xl border border-slate-200 bg-white p-4">
                <div class="text-sm font-semibold text-slate-800">New Pool</div>
                <div class="mt-2 grid grid-cols-1 gap-3">
                  <InputText v-model="newPoolName" placeholder="e.g. Pool A" class="!rounded-xl !px-4 !py-3" />
                  <InputText v-model="newPoolCourt" placeholder="Court (optional)" class="!rounded-xl !px-4 !py-3" />
                  <Button
                    :loading="saving"
                    label="Create"
                    icon="pi pi-plus"
                    class="!rounded-xl border-none text-white gbv-grad-blue"
                    @click="createPool"
                  />
                </div>
              </div>

              <div v-if="selectedPool" class="mt-4 rounded-xl border border-slate-200 bg-white p-4">
                <div class="text-sm font-semibold text-slate-800">Edit Pool</div>
                <div class="mt-2 grid grid-cols-1 gap-3">
                  <InputText v-model="editPoolName" placeholder="Pool name" class="!rounded-xl !px-4 !py-3" />
                  <InputText v-model="editCourt" placeholder="Court (optional)" class="!rounded-xl !px-4 !py-3" />
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
                  class="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800"
                >
                  Warning: Duplicate seeds found in this pool.
                </div>
              </div>
            </div>
          </div>

          <!-- Drag-and-drop area -->
          <div class="lg:col-span-2">
            <div class="grid grid-cols-1 gap-6">
              <!-- Unassigned teams -->
              <div
                class="rounded-xl bg-gbv-bg p-4"
                @dragover="allowDrop"
                @drop="onDropToPool(null)"
              >
                <div class="flex items-center justify-between">
                  <h3 class="text-lg font-semibold text-slate-900">Unassigned Teams</h3>
                  <div class="text-xs text-slate-600">Drag onto a pool to assign</div>
                </div>
                <div class="mt-3 grid gap-2 sm:grid-cols-2">
                  <div
                    v-for="t in unassignedTeams"
                    :key="t.id"
                    class="rounded-lg border border-slate-200 bg-white p-3 shadow-sm cursor-move"
                    draggable="true"
                    @dragstart="onDragStartTeam(t.id)"
                    title="Drag to move to a pool"
                  >
                    <div class="font-medium">{{ t.seeded_player_name }}</div>
                    <div class="text-xs text-slate-500">No pool</div>
                  </div>
                </div>
              </div>

              <!-- Pools with teams -->
              <div class="grid grid-cols-1 gap-6 sm:grid-cols-2">
                <div
                  v-for="p in pools"
                  :key="p.id"
                  class="rounded-xl border border-slate-200 bg-white"
                >
                  <div
                    class="rounded-t-xl bg-gbv-bg p-3"
                    @dragover="allowDrop"
                    @drop="onDropToPool(p.id)"
                  >
                    <div class="flex items-center justify-between">
                      <div class="font-semibold text-slate-800">
                        {{ p.name }} <span class="text-slate-500 text-xs">Court: {{ p.court_assignment || 'TBD' }}</span>
                      </div>
                      <div
                        v-if="poolHasSeedConflicts(p.id)"
                        class="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700"
                        title="Duplicate seeds present"
                      >
                        Seed conflict
                      </div>
                    </div>
                    <div class="text-xs text-slate-500">Drop here to assign</div>
                  </div>

                  <div class="p-3">
                    <div
                      v-for="t in teamsForPool(p.id)"
                      :key="t.id"
                      class="mb-2 flex items-center justify-between rounded-lg border border-slate-200 bg-white p-3 shadow-sm"
                      draggable="true"
                      @dragstart="onDragStartTeam(t.id)"
                      title="Drag to move to another pool or to Unassigned"
                    >
                      <div>
                        <div class="font-medium">{{ t.seeded_player_name }}</div>
                        <div class="text-xs text-slate-500">ID: {{ t.id.slice(0, 8) }}…</div>
                      </div>
                      <div class="flex items-center gap-2">
                        <label class="text-sm text-slate-600">Seed</label>
                        <InputText
                          :value="t.seed_in_pool ?? ''"
                          style="width: 4.5rem"
                          class="!rounded-xl !px-3 !py-2"
                          placeholder="1"
                          @change="(e:any) => setSeed(t.id, e.target.value)"
                        />
                      </div>
                    </div>

                    <div v-if="teamsForPool(p.id).length === 0" class="text-sm text-slate-500">
                      No teams yet.
                    </div>
                  </div>
                </div>
              </div>

              <div class="rounded-xl border border-dashed border-slate-300 p-4 text-center text-sm text-slate-600">
                Tip: Drag a team card to the "Unassigned Teams" header area to remove it from a pool.
              </div>
            </div>
          </div>
        </div>

        <div class="mt-6 text-sm text-slate-600">
          Seeds must be unique within each pool. You can leave seeds blank temporarily, but schedule generation requires complete seeding.
        </div>
      </div>
    </div>
  </section>
</template>