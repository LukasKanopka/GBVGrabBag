<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useToast } from 'primevue/usetoast';
import InputText from 'primevue/inputtext';
import Button from 'primevue/button';
import DataTable from 'primevue/datatable';
import Column from 'primevue/column';
import supabase from '../lib/supabase';
import { useSessionStore } from '../stores/session';
import UiSectionHeading from '@/components/ui/UiSectionHeading.vue';
import UiAccordion from '@/components/ui/UiAccordion.vue';
import { normalizeCell } from '../lib/csv';

type TeamRow = {
  id: string;
  full_team_name: string;
  seed_global: number | null;
};

const router = useRouter();
const toast = useToast();
const session = useSessionStore();

const accessCode = ref<string>('');
const loading = ref(false);

// Existing teams in DB for the tournament
const teams = ref<TeamRow[]>([]);

// Manual input
const manualTeamName = ref<string>('');

function changeTournamentCode() {
  session.tournament = null as any;
  session.setAccessCode('');
  accessCode.value = '';
  teams.value = [];
}

async function loadTournamentByAccessCode() {
  if (!accessCode.value?.trim()) {
    toast.add({ severity: 'warn', summary: 'Access code required', life: 2000 });
    return;
  }
  loading.value = true;
  try {
    await session.ensureAnon();
    session.initFromStorage();
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
  const { data, error } = await supabase
    .from('teams')
    .select('id,full_team_name,seed_global')
    .eq('tournament_id', session.tournament.id)
    .order('seed_global', { ascending: true })
    .order('full_team_name', { ascending: true });

  if (error) {
    toast.add({ severity: 'error', summary: 'Failed to load teams', detail: error.message, life: 2500 });
    teams.value = [];
    return;
  }
  teams.value = (data || []) as TeamRow[];
}

async function createTeam() {
  if (!session.tournament) {
    toast.add({ severity: 'warn', summary: 'Load a tournament first', life: 2000 });
    return;
  }
  const name = normalizeCell(manualTeamName.value);
  if (!name) {
    toast.add({ severity: 'warn', summary: 'Team name required', life: 2000 });
    return;
  }

  // Enforce no duplicates in DB (case-insensitive) before insert (matches unique index intent)
  const existingLc = new Set(teams.value.map((t) => normalizeCell(t.full_team_name).toLowerCase()).filter(Boolean));
  const lc = name.toLowerCase();
  if (existingLc.has(lc)) {
    toast.add({ severity: 'warn', summary: 'Duplicate team name', detail: name, life: 2500 });
    return;
  }

  // Find next global seed
  let startSeed = 0;
  {
    const { data: maxSeedRows } = await supabase
      .from('teams')
      .select('seed_global')
      .eq('tournament_id', session.tournament.id)
      .not('seed_global', 'is', null)
      .order('seed_global', { ascending: false })
      .limit(1);
    if (Array.isArray(maxSeedRows) && maxSeedRows.length > 0 && typeof (maxSeedRows[0] as any).seed_global === 'number') {
      startSeed = (maxSeedRows[0] as any).seed_global as number;
    }
  }

  const payload = {
    tournament_id: session.tournament!.id,
    seeded_player_name: name, // legacy column; keep in sync
    full_team_name: name,
    seed_global: startSeed + 1,
    pool_id: null,
    seed_in_pool: null,
  };

  const { error } = await supabase.from('teams').insert(payload);
  if (error) {
    toast.add({ severity: 'error', summary: 'Insert failed', detail: error.message, life: 3000 });
    return;
  }

  manualTeamName.value = '';
  toast.add({ severity: 'success', summary: 'Team created', detail: name, life: 1500 });
  await loadTeams();
}

// Inline edit/delete
const editDialogOpen = ref(false);
const selectedTeam = ref<TeamRow | null>(null);
const editTeamName = ref<string>('');

function openEdit(team: TeamRow) {
  selectedTeam.value = team;
  editTeamName.value = normalizeCell(team.full_team_name);
  editDialogOpen.value = true;
}

async function applyEdit() {
  if (!session.tournament || !selectedTeam.value) return;
  const name = normalizeCell(editTeamName.value);
  if (!name) {
    toast.add({ severity: 'warn', summary: 'Team name required', life: 2000 });
    return;
  }

  const { error } = await supabase
    .from('teams')
    .update({ full_team_name: name, seeded_player_name: name })
    .eq('id', selectedTeam.value.id)
    .eq('tournament_id', session.tournament.id);

  if (error) {
    toast.add({ severity: 'error', summary: 'Update failed', detail: error.message, life: 3000 });
    return;
  }

  toast.add({ severity: 'success', summary: 'Team updated', life: 1200 });
  editDialogOpen.value = false;
  selectedTeam.value = null;
  await loadTeams();
}

async function deleteTeam(team: TeamRow) {
  if (!session.tournament) return;
  const ok = confirm(`Delete "${team.full_team_name}"? This cannot be undone.`);
  if (!ok) return;
  const { error } = await supabase.from('teams').delete().eq('id', team.id).eq('tournament_id', session.tournament.id);
  if (error) {
    toast.add({ severity: 'error', summary: 'Delete failed', detail: error.message, life: 3000 });
    return;
  }
  toast.add({ severity: 'success', summary: 'Team deleted', life: 1200 });
  await loadTeams();
}

onMounted(async () => {
  try {
    await session.ensureAnon();
    session.initFromStorage();

    if (session.tournament) {
      await loadTeams();
      return;
    }

    if (session.accessCode) {
      accessCode.value = session.accessCode;
      const t = await session.loadTournamentByCode(session.accessCode);
      if (t) await loadTeams();
    }
  } catch {
    // ignore
  }
});
</script>

<template>
  <section class="mx-auto max-w-6xl px-4 py-6">
    <UiSectionHeading
      title="Teams"
      subtitle="Recommended: create teams + pools in one step by uploading a Pools CSV on the Pools & Seeds page."
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

    <!-- Tournament context -->
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
      <div v-else class="flex items-center justify-between">
        <div class="text-sm">
          Tournament:
          <span class="font-semibold">{{ session.tournament?.name }}</span>
          <span class="ml-2 text-white/80">({{ session.accessCode }})</span>
        </div>
        <Button
          label="Change"
          severity="secondary"
          text
          class="!rounded-xl !text-white"
          icon="pi pi-external-link"
          @click="changeTournamentCode"
        />
      </div>
    </div>

    <div class="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
      <!-- Preferred workflow -->
      <div class="rounded-lg border border-white/15 bg-white/5 p-4">
        <div class="text-sm font-semibold">Preferred: Pools CSV Import</div>
        <div class="mt-2 text-sm text-white/80">
          To auto-generate teams + pools (and pool seeds), go to <span class="font-semibold">Pools &amp; Seeds</span> and use
          <span class="font-mono">pool1,pool2,pool3,pool4</span> columns in the template.
        </div>
        <div class="mt-3">
          <Button
            label="Go to Pools & Seeds"
            icon="pi pi-external-link"
            class="!rounded-xl border-none text-white gbv-grad-green"
            @click="router.push({ name: 'admin-pools-seeds' })"
          />
        </div>
      </div>

      <!-- Manual Add / Existing Players -->
      <div>
        <UiAccordion title="Manual Add / Existing Teams" :defaultOpen="true">
          <div class="grid gap-4">
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 items-end">
              <div>
                <label class="block text-sm mb-2">Team Name</label>
                <InputText
                  v-model="manualTeamName"
                  placeholder="e.g. Alice + Bob"
                  class="w-full !rounded-xl !px-4 !py-3 !bg-white !text-slate-900"
                />
              </div>
              <div class="flex">
                <Button
                  :disabled="!manualTeamName.trim()"
                  label="Create Team"
                  icon="pi pi-check"
                  class="!rounded-xl border-none text-white gbv-grad-blue"
                  @click="createTeam"
                />
              </div>
            </div>

            <!-- Mobile-first existing teams list -->
            <div class="rounded-lg border border-white/15 overflow-hidden lg:hidden">
              <div
                v-for="t in teams"
                :key="t.id"
                class="px-4 py-3 border-b border-white/10 last:border-b-0"
              >
                <div class="font-medium">{{ t.full_team_name }}</div>
                <div class="text-xs text-white/80">Seed: {{ t.seed_global ?? '—' }}</div>
                <div class="mt-2 flex gap-2">
                  <Button label="Edit" size="small" text class="!text-white" @click="openEdit(t)" />
                  <Button label="Delete" size="small" text severity="danger" @click="deleteTeam(t)" />
                </div>
              </div>
              <div v-if="teams.length === 0" class="px-4 py-3 text-sm text-white/80">No teams yet.</div>
            </div>

            <!-- Desktop DataTable existing teams -->
            <div class="hidden lg:block">
              <DataTable
                :value="teams"
                size="small"
                class="rounded-xl overflow-hidden"
                tableClass="!text-sm"
                :paginator="true"
                :rows="8"
                :pt="{
                  table: { class: 'bg-transparent' },
                  thead: { class: 'bg-white/10 text-white' },
                  tbody: { class: 'text-white/90' }
                }"
              >
                <Column field="full_team_name" header="Team Name" headerClass="!bg-white/10 !text-white" />
                <Column field="seed_global" header="Global Seed" headerClass="!bg-white/10 !text-white" />
                <Column header="Actions" style="width: 12rem" headerClass="!bg-white/10 !text-white">
                  <template #body="{ data }">
                    <div class="flex gap-2">
                      <Button label="Edit" size="small" text class="!text-white" @click="openEdit(data)" />
                      <Button label="Delete" size="small" text severity="danger" @click="deleteTeam(data)" />
                    </div>
                  </template>
                </Column>
              </DataTable>
            </div>

            <!-- Inline editor -->
            <div
              v-if="editDialogOpen"
              class="rounded-lg border border-white/15 bg-white/5 p-4"
            >
              <div class="text-sm font-semibold">Edit Team</div>
              <div class="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3 items-end">
                <div class="sm:col-span-2">
                  <label class="block text-sm mb-2">Team Name</label>
                  <InputText v-model="editTeamName" class="w-full !rounded-xl !px-4 !py-3 !bg-white !text-slate-900" />
                </div>
              </div>
              <div class="mt-3 flex gap-2">
                <Button label="Save" class="!rounded-xl border-none text-white gbv-grad-blue" @click="applyEdit" />
                <Button
                  label="Cancel"
                  severity="secondary"
                  outlined
                  class="!rounded-xl !border-white/40 !text-white hover:!bg-white/10"
                  @click="editDialogOpen = false"
                />
              </div>
            </div>
          </div>
        </UiAccordion>
      </div>
    </div>
  </section>
</template>

<style scoped>
</style>
