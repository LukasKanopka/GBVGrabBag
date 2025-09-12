<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useToast } from 'primevue/usetoast';
import InputText from 'primevue/inputtext';
import Textarea from 'primevue/textarea';
import Button from 'primevue/button';
import DataTable from 'primevue/datatable';
import Column from 'primevue/column';
import supabase from '../lib/supabase';
import { useSessionStore } from '../stores/session';

type TeamRow = {
  id: string;
  seeded_player_name: string;
  full_team_name: string;
};

type PreviewRow = {
  name: string;
  status: 'new' | 'existing' | 'duplicate_in_file';
};

const router = useRouter();
const toast = useToast();
const session = useSessionStore();

const accessCode = ref<string>('');
const loading = ref(false);

// Existing teams in DB for the tournament
const teams = ref<TeamRow[]>([]);

// CSV and manual input
const fileInput = ref<HTMLInputElement | null>(null);
const parsedNames = ref<string[]>([]);
const manualName = ref<string>('');

// Preview list derived from parsedNames vs DB state
const preview = computed<PreviewRow[]>(() => {
  const seenFile: Set<string> = new Set();
  const existingNamesLc = new Set(
    teams.value.map((t) => t.seeded_player_name.trim().toLowerCase())
  );
  return parsedNames.value.map((raw) => {
    const name = raw.trim();
    const lc = name.toLowerCase();
    if (seenFile.has(lc)) {
      return { name, status: 'duplicate_in_file' as const };
    }
    seenFile.add(lc);
    if (existingNamesLc.has(lc)) {
      return { name, status: 'existing' as const };
    }
    return { name, status: 'new' as const };
  });
});

const canInsertCount = computed(() => preview.value.filter((p) => p.status === 'new').length);

function resetFileInput() {
  if (fileInput.value) {
    fileInput.value.value = '';
  }
}

// Utilities

function normalizeName(name: string) {
  return name.replace(/\s+/g, ' ').trim();
}

function parseCsvSingleColumn(text: string) {
  // Expect UTF-8 text; single column: seeded_player_name; first line may be header "seeded_player_name"
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const filtered = lines.filter((l) => l.length > 0);
  if (filtered.length === 0) return [];

  const first = filtered[0].toLowerCase();
  const hasHeader = first === 'seeded_player_name';

  const names = (hasHeader ? filtered.slice(1) : filtered)
    .map(normalizeName)
    .filter((n) => !!n);

  return names;
}

// Load tournament + teams

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
    .select('id,seeded_player_name,full_team_name')
    .eq('tournament_id', session.tournament.id)
    .order('seeded_player_name', { ascending: true });

  if (error) {
    toast.add({ severity: 'error', summary: 'Failed to load teams', detail: error.message, life: 2500 });
    teams.value = [];
    return;
  }
  teams.value = (data || []) as TeamRow[];
}

// CSV handlers

async function handleFileChange(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;

  try {
    const text = await file.text();
    const names = parseCsvSingleColumn(text);
    if (names.length === 0) {
      toast.add({ severity: 'warn', summary: 'CSV empty', life: 2000 });
      return;
    }
    parsedNames.value = names;
    toast.add({ severity: 'success', summary: 'CSV parsed', detail: `${names.length} line(s)`, life: 1500 });
  } catch (err: any) {
    toast.add({ severity: 'error', summary: 'Parse failed', detail: err?.message ?? 'Unknown error', life: 3000 });
  } finally {
    resetFileInput();
  }
}

function clearPreview() {
  parsedNames.value = [];
}

// Manual add to preview list

function addManualToPreview() {
  const name = normalizeName(manualName.value);
  if (!name) return;
  parsedNames.value = [...parsedNames.value, name];
  manualName.value = '';
}

// Insert new players

async function insertNewPlayers() {
  if (!session.tournament) {
    toast.add({ severity: 'warn', summary: 'Load a tournament first', life: 2000 });
    return;
  }
  const newOnes = preview.value.filter((p) => p.status === 'new').map((p) => p.name);
  if (newOnes.length === 0) {
    toast.add({ severity: 'info', summary: 'Nothing to insert', life: 1500 });
    return;
  }

  const rows = newOnes.map((name) => ({
    tournament_id: session.tournament!.id,
    pool_id: null,
    seeded_player_name: name,
    partner_name: null,
    full_team_name: name, // initial full name equals seeded name
    seed_in_pool: null,
  }));

  loading.value = true;
  try {
    const { error } = await supabase.from('teams').insert(rows);
    if (error) throw error;
    toast.add({ severity: 'success', summary: `Inserted ${rows.length} player(s)`, life: 1500 });
    // refresh state
    await loadTeams();
    // remove those names from preview list so only unresolved remain
    const newSetLc = new Set(newOnes.map((n) => n.toLowerCase()));
    parsedNames.value = parsedNames.value.filter((n) => !newSetLc.has(n.toLowerCase()));
  } catch (err: any) {
    toast.add({ severity: 'error', summary: 'Insert failed', detail: err?.message ?? 'Unknown error', life: 3500 });
  } finally {
    loading.value = false;
  }
}

// Manual CRUD on existing teams

const selectedTeam = ref<TeamRow | null>(null);
const editName = ref<string>('');
const editDialogOpen = ref(false);

function openEdit(team: TeamRow) {
  selectedTeam.value = team;
  editName.value = team.seeded_player_name;
  editDialogOpen.value = true;
}

async function applyEdit() {
  if (!selectedTeam.value) return;
  const newName = normalizeName(editName.value);
  if (!newName) {
    toast.add({ severity: 'warn', summary: 'Name required', life: 2000 });
    return;
  }
  try {
    const { error } = await supabase
      .from('teams')
      .update({
        seeded_player_name: newName,
        full_team_name: newName, // keep in sync until partner set later
      })
      .eq('id', selectedTeam.value.id);
    if (error) throw error;
    toast.add({ severity: 'success', summary: 'Player updated', life: 1200 });
    editDialogOpen.value = false;
    await loadTeams();
  } catch (err: any) {
    toast.add({ severity: 'error', summary: 'Update failed', detail: err?.message ?? 'Unknown error', life: 3000 });
  }
}

async function deleteTeam(team: TeamRow) {
  const ok = confirm(`Delete "${team.seeded_player_name}"? This cannot be undone.`);
  if (!ok) return;
  try {
    const { error } = await supabase.from('teams').delete().eq('id', team.id);
    if (error) throw error;
    toast.add({ severity: 'success', summary: 'Deleted', life: 1200 });
    await loadTeams();
  } catch (err: any) {
    toast.add({ severity: 'error', summary: 'Delete failed', detail: err?.message ?? 'Unknown error', life: 3000 });
  }
}

onMounted(async () => {
  // No-op until a tournament is loaded; keep consistent with other admin pages
});
</script>

<template>
  <section class="mx-auto max-w-6xl px-4 pb-10 pt-6">
    <div class="rounded-2xl border border-slate-200 bg-white shadow-lg">
      <div class="p-5 sm:p-7">
        <div class="flex items-center justify-between gap-3">
          <div>
            <h2 class="text-2xl font-semibold text-slate-900">Players Import</h2>
            <p class="mt-1 text-slate-600">
              Upload a CSV with one column "seeded_player_name" (header required) or add manually.
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

        <div class="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-2">
          <!-- CSV import panel -->
          <div class="rounded-xl bg-gbv-bg p-4">
            <h3 class="text-lg font-semibold text-slate-900">CSV Import</h3>
            <p class="mt-1 text-sm text-slate-700">
              CSV must contain a single column with header <code>seeded_player_name</code>.
            </p>
            <div class="mt-3 flex items-center gap-3">
              <input
                ref="fileInput"
                type="file"
                accept=".csv,text/csv"
                class="block w-full text-sm text-slate-700"
                @change="handleFileChange"
              />
              <Button
                label="Clear"
                size="small"
                severity="secondary"
                outlined
                class="!rounded-xl"
                @click="clearPreview"
              />
            </div>

            <div class="mt-4">
              <DataTable :value="preview" size="small" class="rounded-xl overflow-hidden" tableClass="!text-sm">
                <Column field="name" header="Name" />
                <Column field="status" header="Status">
                  <template #body="{ data }">
                    <span
                      :class="{
                        'px-2 py-1 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-700': data.status === 'new',
                        'px-2 py-1 rounded-full text-xs font-semibold bg-slate-100 text-slate-700': data.status === 'existing',
                        'px-2 py-1 rounded-full text-xs font-semibold bg-amber-100 text-amber-700': data.status === 'duplicate_in_file'
                      }"
                    >
                      {{ data.status.replaceAll('_', ' ') }}
                    </span>
                  </template>
                </Column>
              </DataTable>

              <div class="mt-3 flex items-center justify-between">
                <div class="text-sm text-slate-600">
                  New to insert: <span class="font-semibold">{{ canInsertCount }}</span>
                </div>
                <Button
                  :disabled="!session.tournament || canInsertCount === 0"
                  label="Insert New Players"
                  icon="pi pi-upload"
                  class="!rounded-xl border-none text-white gbv-grad-blue"
                  @click="insertNewPlayers"
                />
              </div>
            </div>
          </div>

          <!-- Manual add and existing list -->
          <div class="rounded-xl bg-gbv-bg p-4">
            <h3 class="text-lg font-semibold text-slate-900">Manual Add / Existing Players</h3>

            <div class="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
              <div class="sm:col-span-2">
                <label class="block text-sm font-medium text-slate-700 mb-2">Seeded Player Name</label>
                <InputText
                  v-model="manualName"
                  placeholder="e.g. Lukas Kanopka"
                  class="w-full !rounded-xl !px-4 !py-3"
                />
              </div>
              <div class="flex">
                <Button
                  :disabled="!manualName.trim()"
                  label="Add to Preview"
                  icon="pi pi-plus"
                  class="!rounded-xl border-none text-white gbv-grad-blue"
                  @click="addManualToPreview"
                />
              </div>
            </div>

            <div class="mt-5">
              <DataTable
                :value="teams"
                size="small"
                class="rounded-xl overflow-hidden"
                tableClass="!text-sm"
                :paginator="true"
                :rows="8"
              >
                <Column field="seeded_player_name" header="Seeded Name" />
                <Column field="full_team_name" header="Full Team Name" />
                <Column header="Actions" style="width: 12rem">
                  <template #body="{ data }">
                    <div class="flex gap-2">
                      <Button label="Edit" size="small" text @click="openEdit(data)" />
                      <Button label="Delete" size="small" text severity="danger" @click="deleteTeam(data)" />
                    </div>
                  </template>
                </Column>
              </DataTable>
            </div>

            <!-- Simple inline editor -->
            <div
              v-if="editDialogOpen"
              class="mt-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
            >
              <div class="text-sm font-semibold text-slate-800">Edit Player</div>
              <div class="mt-2 grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
                <div class="sm:col-span-2">
                  <label class="block text-sm font-medium text-slate-700 mb-2">Seeded Player Name</label>
                  <InputText v-model="editName" class="w-full !rounded-xl !px-4 !py-3" />
                </div>
                <div class="flex gap-2">
                  <Button label="Save" class="!rounded-xl border-none text-white gbv-grad-blue" @click="applyEdit" />
                  <Button label="Cancel" severity="secondary" outlined class="!rounded-xl" @click="editDialogOpen = false" />
                </div>
              </div>
              <p class="mt-2 text-xs text-slate-500">
                Note: full_team_name mirrors this value until partner assignment.
              </p>
            </div>
          </div>
        </div>

        <div class="mt-6 text-sm text-slate-600">
          Tip: Avoid duplicates. The importer de-duplicates within the CSV and skips players already present in the tournament.
        </div>
      </div>
    </div>
  </section>
</template>