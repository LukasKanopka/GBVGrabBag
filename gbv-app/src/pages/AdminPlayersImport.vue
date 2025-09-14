<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
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

function removePreviewAt(idx: number) {
  parsedNames.value = parsedNames.value.filter((_, i) => i !== idx);
}

// Manual add to preview list

function addManualToPreview() {
  const name = normalizeName(manualName.value);
  if (!name) return;
  parsedNames.value = [...parsedNames.value, name];
  manualName.value = '';
}

// Insert new players

// Preflight: ensure tournament exists in DB to avoid FK 23503
async function ensureTournamentExists(): Promise<boolean> {
  try {
    await session.ensureAnon();
    session.initFromStorage();

    // If no tournament loaded, try loading via stored access code
    if (!session.tournament) {
      if (session.accessCode) {
        const t = await session.loadTournamentByCode(session.accessCode);
        return !!t;
      }
      return false;
    }

    // Verify the referenced tournament id still exists server-side
    const { data, error } = await supabase
      .from('tournaments')
      .select('id')
      .eq('id', session.tournament.id)
      .single();

    if (error || !data) {
      // Clear stale tournament reference
      session.tournament = null;
      return false;
    }
    return true;
  } catch {
    return false;
  }
}
async function insertNewPlayers() {
  const ok = await ensureTournamentExists();
  if (!ok || !session.tournament) {
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
    const code = (err && typeof err === 'object') ? (err as any).code : undefined;
    if (code === '23503') {
      // teams.tournament_id FK violation => referenced tournament no longer exists
      session.tournament = null;
      toast.add({
        severity: 'error',
        summary: 'Tournament missing',
        detail: 'The selected tournament no longer exists. Load a valid tournament via access code and try again.',
        life: 4000,
      });
    } else {
      toast.add({ severity: 'error', summary: 'Insert failed', detail: err?.message ?? 'Unknown error', life: 3500 });
    }
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

function changeTournamentCode() {
  session.clearAccessCode();
  accessCode.value = '';
  teams.value = [];
  parsedNames.value = [];
  toast.add({ severity: 'info', summary: 'Tournament cleared', life: 1500 });
  router.push({ name: 'tournament-public' });
}

onMounted(async () => {
  try {
    await session.ensureAnon();
    session.initFromStorage();
    if (!session.tournament && session.accessCode) {
      const t = await session.loadTournamentByCode(session.accessCode);
      if (t) {
        toast.add({ severity: 'info', summary: 'Tournament restored', detail: t.name, life: 1200 });
        await loadTeams();
      }
    }
  } catch {
    // ignore restore errors
  }
});
</script>

<template>
  <section class="mx-auto max-w-6xl px-4 py-6">
    <UiSectionHeading
      title="Players Import"
      subtitle="Upload a CSV (seeded_player_name) or add manually. Designed mobile-first; desktop table appears on larger screens."
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

    <!-- CSV Import and Manual Add -->
    <div class="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
      <!-- CSV Import -->
      <div>
        <UiAccordion title="CSV Import" :defaultOpen="true" subtitle="Single column with header seeded_player_name">
          <div class="grid gap-3">
            <div class="flex items-center gap-3">
              <input
                ref="fileInput"
                type="file"
                accept=".csv,text/csv"
                class="block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-white file:px-3 file:py-2 file:text-slate-900"
                @change="handleFileChange"
              />
              <Button
                label="Clear"
                size="small"
                severity="secondary"
                outlined
                class="!rounded-xl !border-white/40 !text-white hover:!bg-white/10"
                @click="clearPreview"
              />
            </div>

            <!-- Mobile-first preview list -->
            <div class="rounded-lg border border-white/15 overflow-hidden lg:hidden" v-if="preview.length">
              <div
                v-for="(row, idx) in preview"
                :key="row.name + '-' + idx"
                class="flex items-center justify-between gap-3 px-4 py-3 border-b border-white/10 last:border-b-0"
              >
                <div class="min-w-0">
                  <div class="font-medium truncate">{{ row.name }}</div>
                  <div class="mt-0.5 text-xs">
                    <span
                      :class="[
                        'px-2 py-0.5 rounded-full font-semibold',
                        row.status === 'new' ? 'bg-emerald-400/20 text-emerald-200' :
                        row.status === 'existing' ? 'bg-white/20 text-white' :
                        'bg-amber-400/20 text-amber-200'
                      ]"
                    >
                      {{ row.status.replace(/_/g, ' ') }}
                    </span>
                  </div>
                </div>
                <div class="shrink-0 flex items-center gap-2">
                  <Button
                    icon="pi pi-times"
                    text
                    severity="secondary"
                    class="!rounded-xl !text-white"
                    @click="removePreviewAt(idx)"
                    :aria-label="'Remove ' + row.name"
                  />
                </div>
              </div>
            </div>

            <!-- Desktop DataTable preview -->
            <div class="hidden lg:block">
              <DataTable
                :value="preview"
                size="small"
                class="rounded-xl overflow-hidden"
                tableClass="!text-sm"
                :pt="{
                  table: { class: 'bg-transparent' },
                  thead: { class: 'bg-white/10 text-white' },
                  tbody: { class: 'text-white/90' }
                }"
              >
                <Column field="name" header="Name" headerClass="!bg-white/10 !text-white" />
                <Column field="status" header="Status" headerClass="!bg-white/10 !text-white">
                  <template #body="{ data }">
                    <span
                      :class="{
                        'px-2 py-1 rounded-full text-xs font-semibold bg-emerald-400/20 text-emerald-200': data.status === 'new',
                        'px-2 py-1 rounded-full text-xs font-semibold bg-white/20 text-white': data.status === 'existing',
                        'px-2 py-1 rounded-full text-xs font-semibold bg-amber-400/20 text-amber-200': data.status === 'duplicate_in_file'
                      }"
                    >
                      {{ data.status.replace(/_/g, ' ') }}
                    </span>
                  </template>
                </Column>
              </DataTable>
            </div>

            <div class="flex items-center justify-between">
              <div class="text-sm text-white/90">
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
        </UiAccordion>
      </div>

      <!-- Manual Add / Existing Players -->
      <div>
        <UiAccordion title="Manual Add / Existing Players" :defaultOpen="true">
          <div class="grid gap-4">
            <div class="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
              <div class="sm:col-span-2">
                <label class="block text-sm mb-2">Seeded Player Name</label>
                <InputText
                  v-model="manualName"
                  placeholder="e.g. Lukas Kanopka"
                  class="w-full !rounded-xl !px-4 !py-3 !bg-white !text-slate-900"
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

            <!-- Mobile-first existing players list -->
            <div class="rounded-lg border border-white/15 overflow-hidden lg:hidden">
              <div
                v-for="t in teams"
                :key="t.id"
                class="px-4 py-3 border-b border-white/10 last:border-b-0"
              >
                <div class="font-medium">{{ t.seeded_player_name }}</div>
                <div class="text-xs text-white/80">{{ t.full_team_name }}</div>
                <div class="mt-2 flex gap-2">
                  <Button label="Edit" size="small" text class="!text-white" @click="openEdit(t)" />
                  <Button label="Delete" size="small" text severity="danger" @click="deleteTeam(t)" />
                </div>
              </div>
              <div v-if="teams.length === 0" class="px-4 py-3 text-sm text-white/80">No players yet.</div>
            </div>

            <!-- Desktop DataTable existing players -->
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
                <Column field="seeded_player_name" header="Seeded Name" headerClass="!bg-white/10 !text-white" />
                <Column field="full_team_name" header="Full Team Name" headerClass="!bg-white/10 !text-white" />
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
              <div class="text-sm font-semibold">Edit Player</div>
              <div class="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
                <div class="sm:col-span-2">
                  <label class="block text-sm mb-2">Seeded Player Name</label>
                  <InputText v-model="editName" class="w-full !rounded-xl !px-4 !py-3 !bg-white !text-slate-900" />
                </div>
                <div class="flex gap-2">
                  <Button label="Save" class="!rounded-xl border-none text-white gbv-grad-blue" @click="applyEdit" />
                  <Button label="Cancel" severity="secondary" outlined class="!rounded-xl !border-white/40 !text-white hover:!bg-white/10" @click="editDialogOpen = false" />
                </div>
              </div>
              <p class="mt-2 text-xs text-white/80">
                Note: full_team_name mirrors this value until partner assignment.
              </p>
            </div>
          </div>
        </UiAccordion>
      </div>
    </div>

    <div class="mt-6 text-sm text-white/80">
      Tip: Avoid duplicates. The importer de-duplicates within the CSV and skips players already present in the tournament.
    </div>
  </section>
</template>

<style scoped>
</style>