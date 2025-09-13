<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useToast } from 'primevue/usetoast';
import InputText from 'primevue/inputtext';
import Button from 'primevue/button';
import DataTable from 'primevue/datatable';
import Column from 'primevue/column';
import ToggleButton from 'primevue/togglebutton';
import supabase from '../lib/supabase';
import { useSessionStore } from '../stores/session';

type TeamRow = {
  id: string;
  pooled_name: string; // "Pool A #1" or "Unassigned"
  seeded_player_name: string;
  partner_name: string | null;
  full_team_name: string;
  pool_id: string | null;
  seed_in_pool: number | null;
};

const router = useRouter();
const toast = useToast();
const session = useSessionStore();

const accessCode = ref<string>(session.accessCode ?? '');
const loading = ref(false);
const savingId = ref<string | null>(null);

const teams = ref<TeamRow[]>([]);
const onlyMissing = ref<boolean>(true);
const searchText = ref<string>('');

// Derived
const totalCount = computed(() => teams.value.length);
const assignedCount = computed(
  () => teams.value.filter((t) => !!t.partner_name && t.partner_name.trim() !== '').length
);
const completeness = computed(() => {
  if (totalCount.value === 0) return 0;
  return Math.round((assignedCount.value / totalCount.value) * 100);
});

const displayRows = computed(() => {
  const q = (searchText.value || '').toLowerCase().trim();
  let rows = teams.value.slice();

  if (onlyMissing.value) {
    rows = rows.filter((t) => !t.partner_name || t.partner_name.trim() === '');
  }
  if (q) {
    rows = rows.filter((t) => {
      const pooled = (t.pooled_name || '').toLowerCase();
      const seeded = (t.seeded_player_name || '').toLowerCase();
      const partner = (t.partner_name || '').toLowerCase();
      const full = (t.full_team_name || '').toLowerCase();
      return pooled.includes(q) || seeded.includes(q) || partner.includes(q) || full.includes(q);
    });
  }

  // Sort by pool name/group then seed number
  return rows.sort((a, b) => {
    if (a.pool_id && b.pool_id) {
      const ap = a.pooled_name.localeCompare(b.pooled_name);
      if (ap !== 0) return ap;
      const as = a.seed_in_pool ?? 9999;
      const bs = b.seed_in_pool ?? 9999;
      if (as !== bs) return as - bs;
    } else if (a.pool_id && !b.pool_id) {
      return -1;
    } else if (!a.pool_id && b.pool_id) {
      return 1;
    }
    return a.seeded_player_name.localeCompare(b.seeded_player_name);
  });
});

// local input model for partner fields
const partnerInput = ref<Record<string, string>>({});

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
      teams.value = [];
      return;
    }
    toast.add({ severity: 'success', summary: 'Tournament loaded', detail: t.name, life: 1500 });
    await loadTeams();
  } finally {
    loading.value = false;
  }
}

async function loadTeams() {
  if (!session.tournament) return;
  const { data: poolsData } = await supabase
    .from('pools')
    .select('id,name,court_assignment')
    .eq('tournament_id', session.tournament.id);

  const poolNameById = new Map<string, string>();
  (poolsData || []).forEach((p: any) => {
    poolNameById.set(p.id, p.name);
  });

  const { data, error } = await supabase
    .from('teams')
    .select('id,seeded_player_name,partner_name,full_team_name,pool_id,seed_in_pool')
    .eq('tournament_id', session.tournament.id);

  if (error) {
    toast.add({ severity: 'error', summary: 'Failed to load teams', detail: error.message, life: 2500 });
    teams.value = [];
    return;
  }

  const rows: TeamRow[] = (data || []).map((t: any) => {
    const poolName = t.pool_id ? poolNameById.get(t.pool_id) || 'Pool ?' : 'Unassigned';
    const pooled = t.pool_id
      ? `${poolName}${t.seed_in_pool ? ` #${t.seed_in_pool}` : ''}`
      : 'Unassigned';
    return {
      id: t.id,
      pooled_name: pooled,
      seeded_player_name: t.seeded_player_name,
      partner_name: t.partner_name,
      full_team_name: t.full_team_name,
      pool_id: t.pool_id,
      seed_in_pool: t.seed_in_pool,
    };
  });

  teams.value = rows;
  // initialize partner inputs
  const inputs: Record<string, string> = {};
  rows.forEach((r) => (inputs[r.id] = r.partner_name ?? ''));
  partnerInput.value = inputs;
}

function computeFullName(seedName: string, partner: string) {
  const p = (partner || '').trim();
  if (!p) return seedName;
  return `${seedName} + ${p}`;
}

async function savePartner(teamId: string) {
  if (!session.tournament) return;
  const row = teams.value.find((t) => t.id === teamId);
  if (!row) return;
  const partner = (partnerInput.value[teamId] || '').trim();
  const fullName = computeFullName(row.seeded_player_name, partner);

  savingId.value = teamId;
  try {
    const { error } = await supabase
      .from('teams')
      .update({
        partner_name: partner || null,
        full_team_name: fullName,
      })
      .eq('id', teamId);

    if (error) throw error;

    row.partner_name = partner || null;
    row.full_team_name = fullName;

    toast.add({ severity: 'success', summary: 'Partner saved', life: 1200 });
  } catch (err: any) {
    toast.add({ severity: 'error', summary: 'Save failed', detail: err?.message ?? 'Unknown error', life: 3000 });
  } finally {
    savingId.value = null;
  }
}

function clearPartner(teamId: string) {
  partnerInput.value[teamId] = '';
  savePartner(teamId);
}

function changeTournamentCode() {
  session.clearAccessCode();
  accessCode.value = '';
  teams.value = [];
  partnerInput.value = {};
  toast.add({ severity: 'info', summary: 'Tournament cleared', life: 1500 });
  router.push({ name: 'tournament-public' });
}

onMounted(() => {
  // Wait for explicit load by access code for consistency with other admin pages
});
</script>

<template>
  <section class="mx-auto max-w-6xl px-4 pb-10 pt-6">
    <div class="rounded-2xl border border-slate-200 bg-white shadow-lg">
      <div class="p-5 sm:p-7">
        <div class="flex items-center justify-between gap-3">
          <div>
            <h2 class="text-2xl font-semibold text-slate-900">Partner Assignment (Hat Draw)</h2>
            <p class="mt-1 text-slate-600">
              Tap a seeded player, enter their drawn partner's name. Team name is finalized as "{Seeded} + {Partner}".
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

        <!-- Tournament context -->
        <div class="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <!-- Loader shown only when no tournament is loaded -->
          <div class="rounded-xl bg-gbv-bg p-4 sm:col-span-3" v-if="!session.tournament">
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
          </div>
          <!-- Subtle chip when tournament is loaded -->
          <div class="rounded-xl bg-gbv-bg p-4 sm:col-span-3" v-else>
            <div class="flex items-center justify-between">
              <div class="text-sm text-slate-700">
                Tournament:
                <span class="font-semibold">{{ session.tournament.name }}</span>
                <span class="ml-2 text-slate-500">({{ session.accessCode }})</span>
              </div>
              <Button
                label="Change"
                severity="secondary"
                text
                class="!rounded-xl"
                icon="pi pi-external-link"
                @click="changeTournamentCode"
              />
            </div>
          </div>
        </div>

        <div v-if="session.tournament" class="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div class="rounded-xl bg-gbv-bg p-4 sm:col-span-3">
            <div class="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
              <div class="sm:col-span-2">
                <label class="block text-sm font-medium text-slate-700 mb-2">Search teams or players</label>
                <InputText
                  v-model="searchText"
                  placeholder="Type to filter by seeded, partner, pool, or team name…"
                  class="w-full !rounded-xl !px-4 !py-3"
                />
              </div>
              <div class="flex items-center justify-between sm:justify-end gap-4">
                <div class="text-sm text-slate-700 whitespace-nowrap">
                  Assigned:
                  <span class="font-semibold">{{ assignedCount }}</span> / {{ totalCount }}
                  <span class="ml-2 text-slate-500">({{ completeness }}%)</span>
                </div>
                <div class="flex items-center gap-2">
                  <span class="text-sm text-slate-700">Only Missing</span>
                  <ToggleButton v-model="onlyMissing" onLabel="Yes" offLabel="No" />
                </div>
              </div>
            </div>
          </div>
        </div>

        <div v-if="session.tournament" class="mt-6">
          <DataTable
            :value="displayRows"
            size="large"
            class="rounded-xl overflow-hidden"
            tableClass="!text-base"
            :paginator="true"
            :rows="12"
          >
            <Column field="pooled_name" header="Pool/Seed" style="width: 12rem" />
            <Column field="seeded_player_name" header="Seeded Player" />
            <Column header="Partner">
              <template #body="{ data }">
                <div class="grid grid-cols-1 gap-2 sm:grid-cols-3 items-center">
                  <div class="sm:col-span-2">
                    <InputText
                      v-model="partnerInput[data.id]"
                      placeholder="Enter partner name"
                      class="w-full !rounded-xl"
                    />
                    <div class="mt-1 text-xs text-slate-500">Team: {{ data.seeded_player_name }} + {{ (partnerInput[data.id] || '').trim() || '—' }}</div>
                  </div>
                  <div class="flex justify-end">
                    <Button
                      :loading="savingId === data.id"
                      label="Save"
                      icon="pi pi-check"
                      class="!rounded-xl border-none text-white gbv-grad-blue"
                      @click="savePartner(data.id)"
                    />
                  </div>
                  <div class="flex justify-end">
                    <Button
                      :loading="savingId === data.id"
                      label="Clear"
                      icon="pi pi-times"
                      severity="secondary"
                      outlined
                      class="!rounded-xl"
                      @click="clearPartner(data.id)"
                    />
                  </div>
                </div>
              </template>
            </Column>
          </DataTable>
        </div>

        <div class="mt-6 text-sm text-slate-600">
          Note: You can clear a partner by saving with an empty partner field. The full team name will revert to the seeded player's name until partner is set.
        </div>
      </div>
    </div>
  </section>
</template>