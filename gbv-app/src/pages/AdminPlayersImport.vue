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
import { csvToObjects, objectsToCsv, normalizeCell } from '../lib/csv';

type TeamRow = {
  id: string;
  full_team_name: string;
  seed_global: number | null;
};

type ParsedImportRow = {
  team_name: string;
};

type PreviewRow = {
  team_name: string;
  status: 'new' | 'existing' | 'duplicate_in_file' | 'invalid_missing_team_name';
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
const parsedRows = ref<ParsedImportRow[]>([]);
const manualTeamName = ref<string>('');

const preview = computed<PreviewRow[]>(() => {
  const seenFile: Set<string> = new Set();
  const existingNamesLc = new Set(
    teams.value.map((t) => normalizeCell(t.full_team_name).toLowerCase()).filter(Boolean)
  );

  return parsedRows.value.map((row) => {
    const teamName = normalizeCell(row.team_name);
    const lc = teamName.toLowerCase();

    if (!teamName) {
      return { team_name: teamName, status: 'invalid_missing_team_name' as const };
    }

    if (seenFile.has(lc)) {
      return { team_name: teamName, status: 'duplicate_in_file' as const };
    }
    seenFile.add(lc);

    if (existingNamesLc.has(lc)) {
      return { team_name: teamName, status: 'existing' as const };
    }

    return { team_name: teamName, status: 'new' as const };
  });
});

const canInsertCount = computed(() => preview.value.filter((p) => p.status === 'new').length);

function resetFileInput() {
  if (fileInput.value) fileInput.value.value = '';
}

function downloadCsv(filename: string, csvText: string) {
  const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function downloadTeamTemplate() {
  const csv = objectsToCsv(
    [{ team_name: 'Add Team Name Here & Below (e.g. Alice + Bob)' }],
    ['team_name']
  );
  downloadCsv('gbv_team_template.csv', csv);
}

function clearPreview() {
  parsedRows.value = [];
}

function removePreviewAt(idx: number) {
  parsedRows.value.splice(idx, 1);
}

function changeTournamentCode() {
  session.tournament = null as any;
  session.setAccessCode('');
  accessCode.value = '';
  teams.value = [];
  parsedRows.value = [];
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

function getTeamNameFromRecord(rec: Record<string, string>): string {
  return normalizeCell(rec.team_name || rec.full_team_name || rec.name || '');
}

async function handleFileChange(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;

  try {
    const text = await file.text();
    const objs = csvToObjects(text);
    if (objs.length === 0) {
      toast.add({ severity: 'warn', summary: 'CSV empty', life: 2000 });
      return;
    }

    // Require a team_name-ish column
    const headers = Object.keys(objs[0] || {});
    const hasTeamNameCol = headers.includes('team_name') || headers.includes('full_team_name') || headers.includes('name');
    if (!hasTeamNameCol) {
      throw new Error('CSV header must include team_name.');
    }

    parsedRows.value = objs.map((o) => ({ team_name: getTeamNameFromRecord(o) }));
    toast.add({ severity: 'success', summary: 'CSV parsed', detail: `${parsedRows.value.length} row(s)`, life: 1500 });
  } catch (err: any) {
    toast.add({ severity: 'error', summary: 'Parse failed', detail: err?.message ?? 'Unknown error', life: 3000 });
  } finally {
    resetFileInput();
  }
}

function addManualToPreview() {
  const name = normalizeCell(manualTeamName.value);
  if (!name) return;
  parsedRows.value.push({ team_name: name });
  manualTeamName.value = '';
}

async function insertNewTeams() {
  if (!session.tournament) {
    toast.add({ severity: 'warn', summary: 'Load a tournament first', life: 2000 });
    return;
  }

  const newOnes = preview.value.filter((p) => p.status === 'new');
  if (newOnes.length === 0) {
    toast.add({ severity: 'info', summary: 'No new teams to insert', life: 1500 });
    return;
  }

  // Enforce no duplicates in DB (case-insensitive) before insert (matches unique index intent)
  const existingLc = new Set(teams.value.map((t) => normalizeCell(t.full_team_name).toLowerCase()).filter(Boolean));
  for (const p of newOnes) {
    const lc = normalizeCell(p.team_name).toLowerCase();
    if (existingLc.has(lc)) {
      toast.add({ severity: 'warn', summary: 'Duplicate team name', detail: p.team_name, life: 2500 });
      return;
    }
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

  const payload = newOnes.map((p, idx) => {
    const name = normalizeCell(p.team_name);
    return {
      tournament_id: session.tournament!.id,
      seeded_player_name: name, // legacy column; keep in sync
      full_team_name: name,
      seed_global: startSeed + idx + 1,
      pool_id: null,
      seed_in_pool: null,
    };
  });

  const { error } = await supabase.from('teams').insert(payload);
  if (error) {
    toast.add({ severity: 'error', summary: 'Insert failed', detail: error.message, life: 3000 });
    return;
  }

  toast.add({ severity: 'success', summary: `Inserted ${payload.length} team(s)`, life: 1500 });

  // Remove inserted from batch
  const insertedLc = new Set(payload.map((r) => normalizeCell(r.full_team_name).toLowerCase()));
  parsedRows.value = parsedRows.value.filter((r) => !insertedLc.has(normalizeCell(r.team_name).toLowerCase()));

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
      title="Players Import"
      subtitle="Upload a header-based CSV with team_name (Google Sheets export supported)."
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
      <!-- CSV Import -->
      <div>
        <UiAccordion
          title="CSV Import"
          :defaultOpen="true"
          subtitle="Requires headers. Use team_name."
        >
          <div class="grid gap-3">
            <div class="flex flex-col sm:flex-row sm:items-center gap-3">
              <input
                ref="fileInput"
                type="file"
                accept=".csv,text/csv"
                class="block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-white file:px-3 file:py-2 file:text-slate-900"
                @change="handleFileChange"
              />
              <div class="flex items-center gap-2">
                <Button
                  label="Template"
                  icon="pi pi-download"
                  size="small"
                  severity="secondary"
                  outlined
                  class="!rounded-xl !border-white/40 !text-white hover:!bg-white/10"
                  @click="downloadTeamTemplate"
                />
              </div>
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
                :key="row.team_name + '-' + idx"
                class="flex items-center justify-between gap-3 px-4 py-3 border-b border-white/10 last:border-b-0"
              >
                <div class="min-w-0">
                  <div class="font-medium truncate">{{ row.team_name || '(missing team_name)' }}</div>
                  <div class="mt-0.5 text-xs">
                    <span
                      :class="[
                        'px-2 py-0.5 rounded-full font-semibold',
                        row.status === 'new' ? 'bg-emerald-400/20 text-emerald-200' :
                        row.status === 'existing' ? 'bg-white/20 text-white' :
                        (row.status === 'duplicate_in_file' ? 'bg-amber-400/20 text-amber-200' : 'bg-rose-400/20 text-rose-200')
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
                    :aria-label="'Remove ' + (row.team_name || 'row')"
                  />
                </div>
              </div>
            </div>

            <!-- Desktop DataTable preview -->
            <div class="hidden lg:block" v-if="preview.length">
              <DataTable
                :value="preview"
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
                <Column field="team_name" header="Team Name" headerClass="!bg-white/10 !text-white" />
                <Column field="status" header="Status" headerClass="!bg-white/10 !text-white" />
                <Column header="Actions" style="width: 6rem" headerClass="!bg-white/10 !text-white">
                  <template #body="{ index }">
                    <Button
                      icon="pi pi-times"
                      text
                      severity="secondary"
                      class="!rounded-xl !text-white"
                      @click="removePreviewAt(index)"
                    />
                  </template>
                </Column>
              </DataTable>
            </div>

            <div class="flex items-center justify-between">
              <div class="text-sm text-white/80">
                New rows to insert: <span class="font-semibold">{{ canInsertCount }}</span>
              </div>
              <Button
                :disabled="canInsertCount === 0"
                label="Insert New Teams"
                icon="pi pi-upload"
                class="!rounded-xl border-none text-white gbv-grad-blue"
                @click="insertNewTeams"
              />
            </div>
          </div>
        </UiAccordion>
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
                  label="Add to Import Batch"
                  icon="pi pi-plus"
                  class="!rounded-xl border-none text-white gbv-grad-blue"
                  @click="addManualToPreview"
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

    <div class="mt-6 text-sm text-white/80">
      Tip: Avoid duplicates. The importer de-duplicates within the CSV and skips teams already present (by team_name).
    </div>
  </section>
</template>

<style scoped>
</style>

