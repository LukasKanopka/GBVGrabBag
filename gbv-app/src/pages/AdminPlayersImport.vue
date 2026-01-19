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

type ParsedImportRow = {
  seeded_player_name: string;
  second_player_name: string;
  team_name: string;
};

type PreviewRow = {
  seeded_player_name: string;
  second_player_name: string;
  team_name: string;
  full_team_name: string;
  status:
    | 'new'
    | 'existing'
    | 'duplicate_in_file'
    | 'invalid_missing_seeded_player_name'
    | 'invalid_missing_second_or_team_name';
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
const manualSeededName = ref<string>('');
const manualSecondPlayerName = ref<string>('');
const manualTeamName = ref<string>('');

// Preview list derived from parsedRows vs DB state
const preview = computed<PreviewRow[]>(() => {
  const seenFile: Set<string> = new Set();
  const existingNamesLc = new Set(
    teams.value.map((t) => t.seeded_player_name.trim().toLowerCase())
  );

  return parsedRows.value.map((row) => {
    const seeded = normalizeName(row.seeded_player_name);
    const second = normalizeName(row.second_player_name);
    const teamName = normalizeName(row.team_name);

    if (!seeded) {
      return {
        seeded_player_name: seeded,
        second_player_name: second,
        team_name: teamName,
        full_team_name: '',
        status: 'invalid_missing_seeded_player_name' as const,
      };
    }

    if (!second && !teamName) {
      return {
        seeded_player_name: seeded,
        second_player_name: second,
        team_name: teamName,
        full_team_name: seeded,
        status: 'invalid_missing_second_or_team_name' as const,
      };
    }

    const full = computeFullTeamName(seeded, second, teamName);
    const lc = seeded.toLowerCase();

    if (seenFile.has(lc)) {
      return {
        seeded_player_name: seeded,
        second_player_name: second,
        team_name: teamName,
        full_team_name: full,
        status: 'duplicate_in_file' as const,
      };
    }
    seenFile.add(lc);

    if (existingNamesLc.has(lc)) {
      return {
        seeded_player_name: seeded,
        second_player_name: second,
        team_name: teamName,
        full_team_name: full,
        status: 'existing' as const,
      };
    }

    return {
      seeded_player_name: seeded,
      second_player_name: second,
      team_name: teamName,
      full_team_name: full,
      status: 'new' as const,
    };
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

function computeFullTeamName(seededPlayerName: string, secondPlayerName: string, teamName: string) {
  const seeded = normalizeName(seededPlayerName);
  const second = normalizeName(secondPlayerName);
  const team = normalizeName(teamName);
  if (team) return team;
  if (second) return `${seeded} + ${second}`;
  return seeded;
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

function downloadDoublesTemplate() {
  const csv = [
    'seeded_player_name,second_player_name',
    'Insert Seeded Player Here & Below, Insert Second Player Here & Below',
  ].join('\n');
  downloadCsv('gbv_doubles_template.csv', csv);
}

function downloadTeamNameTemplate() {
  const csv = [
    'seeded_player_name,team_name',
    'Add Seeded Player Name Here & Below, Add Team Name Here & Below',
  ].join('\n');
  downloadCsv('gbv_team_name_template.csv', csv);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function computeFullTeamNameForSeedChange(oldSeededName: string, newSeededName: string, existingFullTeamName: string) {
  const oldSeed = normalizeName(oldSeededName);
  const nextSeed = normalizeName(newSeededName);
  const existing = normalizeName(existingFullTeamName);

  if (!oldSeed || !nextSeed) return nextSeed || existing || '';

  // If no second/team name assigned yet, full mirrors seeded player name.
  if (existing.toLowerCase() === oldSeed.toLowerCase()) return nextSeed;

  // If full looks like "{Seeded} + {Second}", preserve the second name and update seeded part.
  const re = new RegExp(`^${escapeRegExp(oldSeed)}\\s*\\+\\s*(.+)$`, 'i');
  const m = existing.match(re);
  if (m && m[1]) {
    const second = m[1].trim();
    return second ? `${nextSeed} + ${second}` : nextSeed;
  }

  // Otherwise, keep existing full name (it may be custom) to avoid accidental corruption.
  return existing;
}

function parseCsvSingleColumn(text: string) {
  // Deprecated: kept only as an internal helper name for historical reasons.
  // We now parse header-based CSVs and support doubles or team-name formats.
  return parseCsvWithHeaders(text);
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        const next = text[i + 1];
        if (next === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }

    if (ch === ',') {
      row.push(field);
      field = '';
      continue;
    }

    if (ch === '\n') {
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
      continue;
    }

    if (ch === '\r') {
      // ignore
      continue;
    }

    field += ch;
  }

  row.push(field);
  if (row.some((c) => c.trim().length > 0)) rows.push(row);

  // Remove trailing empty rows (common from editors)
  while (rows.length > 0 && rows[rows.length - 1].every((c) => (c ?? '').trim() === '')) {
    rows.pop();
  }

  return rows;
}

function normalizeHeader(h: string) {
  // Trim BOM + normalize to snake-ish identifiers
  return (h || '')
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
}

function parseCsvWithHeaders(text: string): ParsedImportRow[] {
  const rows = parseCsv(text);
  if (rows.length === 0) return [];

  const headers = (rows[0] || []).map(normalizeHeader);

  const colIndex = (candidates: string[]) => {
    for (const c of candidates) {
      const idx = headers.indexOf(c);
      if (idx >= 0) return idx;
    }
    return -1;
  };

  const seededIdx = colIndex(['seeded_player_name', 'seated_player_name']);
  const secondIdx = colIndex(['second_player_name', 'player2_name']);
  const teamIdx = colIndex(['team_name']);

  if (seededIdx < 0) {
    throw new Error('CSV header must include seeded_player_name (or seated_player_name).');
  }
  if (secondIdx < 0 && teamIdx < 0) {
    throw new Error('CSV must include either second_player_name (doubles) or team_name (team-name tournaments).');
  }

  const out: ParsedImportRow[] = [];
  for (const raw of rows.slice(1)) {
    const seeded = normalizeName(raw[seededIdx] ?? '');
    const second = normalizeName(secondIdx >= 0 ? (raw[secondIdx] ?? '') : '');
    const teamName = normalizeName(teamIdx >= 0 ? (raw[teamIdx] ?? '') : '');

    // Keep even "invalid" rows so the UI can show them and the user can remove/fix upstream.
    out.push({
      seeded_player_name: seeded,
      second_player_name: second,
      team_name: teamName,
    });
  }
  return out;
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
    const rows = parseCsvSingleColumn(text);
    if (rows.length === 0) {
      toast.add({ severity: 'warn', summary: 'CSV empty', life: 2000 });
      return;
    }
    parsedRows.value = rows;
    toast.add({ severity: 'success', summary: 'CSV parsed', detail: `${rows.length} row(s)`, life: 1500 });
  } catch (err: any) {
    toast.add({ severity: 'error', summary: 'Parse failed', detail: err?.message ?? 'Unknown error', life: 3000 });
  } finally {
    resetFileInput();
  }
}

function clearPreview() {
  parsedRows.value = [];
}

function removePreviewAt(idx: number) {
  parsedRows.value = parsedRows.value.filter((_, i) => i !== idx);
}

// Manual add to preview list

function addManualToPreview() {
  const seeded = normalizeName(manualSeededName.value);
  const second = normalizeName(manualSecondPlayerName.value);
  const teamName = normalizeName(manualTeamName.value);
  if (!seeded) return;
  parsedRows.value = [
    ...parsedRows.value,
    {
      seeded_player_name: seeded,
      second_player_name: second,
      team_name: teamName,
    },
  ];
  manualSeededName.value = '';
  manualSecondPlayerName.value = '';
  manualTeamName.value = '';
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
  const newOnes = preview.value.filter((p) => p.status === 'new');
  if (newOnes.length === 0) {
    toast.add({ severity: 'info', summary: 'Nothing to insert', life: 1500 });
    return;
  }

  // Determine starting global seed (1-based, continuous per tournament)
  let startSeed = 0;
  try {
    const { data: maxSeedRows } = await supabase
      .from('teams')
      .select('seed_global')
      .eq('tournament_id', session.tournament!.id)
      .not('seed_global', 'is', null)
      .order('seed_global', { ascending: false })
      .limit(1);
    if (Array.isArray(maxSeedRows) && maxSeedRows.length > 0 && typeof (maxSeedRows[0] as any).seed_global === 'number') {
      startSeed = (maxSeedRows[0] as any).seed_global as number;
    }
  } catch {
    // fallback to 0; unique constraint will guard conflicts if any race occurs
    startSeed = 0;
  }

  const rows = newOnes.map((p, idx) => ({
    tournament_id: session.tournament!.id,
    pool_id: null,
    seeded_player_name: p.seeded_player_name,
    full_team_name: p.full_team_name,
    seed_in_pool: null,
    seed_global: startSeed + idx + 1,
  }));

  loading.value = true;
  try {
    const { error } = await supabase.from('teams').insert(rows);
    if (error) throw error;
    toast.add({ severity: 'success', summary: `Inserted ${rows.length} team(s)`, life: 1500 });
    // refresh state
    await loadTeams();
    // remove those names from preview list so only unresolved remain
    const newSetLc = new Set(newOnes.map((r) => r.seeded_player_name.toLowerCase()));
    parsedRows.value = parsedRows.value.filter((r) => !newSetLc.has((r.seeded_player_name || '').toLowerCase()));
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
const editFullTeamName = ref<string>('');
const editDialogOpen = ref(false);

function openEdit(team: TeamRow) {
  selectedTeam.value = team;
  editName.value = team.seeded_player_name;
  editFullTeamName.value = team.full_team_name;
  editDialogOpen.value = true;
}

async function applyEdit() {
  if (!selectedTeam.value) return;
  const newName = normalizeName(editName.value);
  if (!newName) {
    toast.add({ severity: 'warn', summary: 'Name required', life: 2000 });
    return;
  }
  const fullInput = normalizeName(editFullTeamName.value);
  const baselineFull = normalizeName(selectedTeam.value.full_team_name);
  const nextFull =
    fullInput && fullInput.toLowerCase() !== baselineFull.toLowerCase()
      ? fullInput
      : computeFullTeamNameForSeedChange(selectedTeam.value.seeded_player_name, newName, selectedTeam.value.full_team_name);
  try {
    const { error } = await supabase
      .from('teams')
      .update({
        seeded_player_name: newName,
        full_team_name: nextFull || newName,
      })
      .eq('id', selectedTeam.value.id);
    if (error) throw error;
    toast.add({ severity: 'success', summary: 'Team updated', life: 1200 });
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
  parsedRows.value = [];
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
      subtitle="Upload a header-based CSV for doubles (seeded_player_name + second_player_name) or team-name tournaments (seeded_player_name + team_name)."
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
	        <UiAccordion
	          title="CSV Import"
	          :defaultOpen="true"
	          subtitle="Requires headers. Use either (seeded_player_name, second_player_name) or (seeded_player_name, team_name)."
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
	                  label="Doubles Template"
	                  icon="pi pi-download"
	                  size="small"
	                  severity="secondary"
	                  outlined
	                  class="!rounded-xl !border-white/40 !text-white hover:!bg-white/10"
	                  @click="downloadDoublesTemplate"
	                />
	                <Button
	                  label="Team Template"
	                  icon="pi pi-download"
	                  size="small"
	                  severity="secondary"
	                  outlined
	                  class="!rounded-xl !border-white/40 !text-white hover:!bg-white/10"
	                  @click="downloadTeamNameTemplate"
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
	                :key="row.seeded_player_name + '-' + idx"
	                class="flex items-center justify-between gap-3 px-4 py-3 border-b border-white/10 last:border-b-0"
	              >
	                <div class="min-w-0">
	                  <div class="font-medium truncate">{{ row.full_team_name || row.seeded_player_name || '(missing seeded_player_name)' }}</div>
	                  <div class="mt-0.5 text-xs text-white/80 truncate" v-if="row.seeded_player_name && row.full_team_name && row.full_team_name !== row.seeded_player_name">
	                    Seeded: {{ row.seeded_player_name }}
	                  </div>
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
	                    :aria-label="'Remove ' + (row.seeded_player_name || 'row')"
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
	                <Column field="seeded_player_name" header="Seeded Player" headerClass="!bg-white/10 !text-white" />
	                <Column field="second_player_name" header="Second Player" headerClass="!bg-white/10 !text-white" />
	                <Column field="team_name" header="Team Name" headerClass="!bg-white/10 !text-white" />
	                <Column field="full_team_name" header="Computed Team" headerClass="!bg-white/10 !text-white" />
	                <Column field="status" header="Status" headerClass="!bg-white/10 !text-white">
	                  <template #body="{ data }">
	                    <span
	                      :class="{
	                        'px-2 py-1 rounded-full text-xs font-semibold bg-emerald-400/20 text-emerald-200': data.status === 'new',
	                        'px-2 py-1 rounded-full text-xs font-semibold bg-white/20 text-white': data.status === 'existing',
	                        'px-2 py-1 rounded-full text-xs font-semibold bg-amber-400/20 text-amber-200': data.status === 'duplicate_in_file',
	                        'px-2 py-1 rounded-full text-xs font-semibold bg-rose-400/20 text-rose-200': data.status.startsWith('invalid_')
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
	                label="Insert New Teams"
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
              <div>
                <label class="block text-sm mb-2">Seeded Player Name</label>
                <InputText
                  v-model="manualSeededName"
                  placeholder="e.g. Seeded Player"
                  class="w-full !rounded-xl !px-4 !py-3 !bg-white !text-slate-900"
                />
              </div>
              <div>
                <label class="block text-sm mb-2">Second Player Name (doubles)</label>
                <InputText
                  v-model="manualSecondPlayerName"
                  placeholder="e.g. Second Player"
                  class="w-full !rounded-xl !px-4 !py-3 !bg-white !text-slate-900"
                />
              </div>
              <div>
                <label class="block text-sm mb-2">Team Name (team-name tournaments)</label>
                <InputText
                  v-model="manualTeamName"
                  placeholder="e.g. The Gators"
                  class="w-full !rounded-xl !px-4 !py-3 !bg-white !text-slate-900"
                />
              </div>
            </div>
            <div class="flex">
              <Button
                :disabled="!manualSeededName.trim() || (!manualSecondPlayerName.trim() && !manualTeamName.trim())"
                label="Add to Import Batch"
                icon="pi pi-plus"
                class="!rounded-xl border-none text-white gbv-grad-blue"
                @click="addManualToPreview"
              />
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
	              <div v-if="teams.length === 0" class="px-4 py-3 text-sm text-white/80">No teams yet.</div>
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
              <div class="text-sm font-semibold">Edit Team</div>
              <div class="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3 items-end">
                <div>
                  <label class="block text-sm mb-2">Seeded Player Name</label>
                  <InputText v-model="editName" class="w-full !rounded-xl !px-4 !py-3 !bg-white !text-slate-900" />
                </div>
                <div>
                  <label class="block text-sm mb-2">Full Team Name</label>
                  <InputText v-model="editFullTeamName" class="w-full !rounded-xl !px-4 !py-3 !bg-white !text-slate-900" />
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
              <p class="mt-2 text-xs text-white/80">
                Tip: For doubles, set full_team_name to "Seeded + Second". For team-name tournaments, set it to the provided team name.
              </p>
            </div>
	          </div>
	        </UiAccordion>
	      </div>
	    </div>

	    <div class="mt-6 text-sm text-white/80">
	      Tip: Avoid duplicates. The importer de-duplicates within the CSV and skips teams already present (by seeded_player_name).
	    </div>
	  </section>
	</template>

<style scoped>
</style>
