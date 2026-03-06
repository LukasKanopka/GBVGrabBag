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
import { csvToObjects, objectsToCsv, normalizeCell } from '../lib/csv';

type Pool = {
  id: string;
  name: string;
  court_assignment: string | null;
  target_size: number | null;
};

type Team = {
  id: string;
  full_team_name: string;
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
const importing = ref(false);

// Pools CSV import (Google Sheets workflow)
type PoolImportRow = {
  team_name: string;
  pool_name: string;
  seed_in_pool: number;
  court_assignment: string | null;
};

const poolCsvInput = ref<HTMLInputElement | null>(null);
const poolImportRows = ref<PoolImportRow[]>([]);
const poolImportErrors = ref<string[]>([]);
const poolImportWarnings = ref<string[]>([]);
const poolImportSummary = ref<{ pools: number; rows: number; missingTeams: number }>({ pools: 0, rows: 0, missingTeams: 0 });

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

// Data
const pools = ref<Pool[]>([]);
const teams = ref<Team[]>([]);

// Local pool edit buffers
const selectedPoolId = ref<string | null>(null);
const editPoolName = ref<string>('');
const editCourt = ref<string>('');
const newPoolName = ref<string>('');
const newPoolCourt = ref<string>('');

// Pool size options (supported: 3–6)
const poolSizeOptions = [3, 4, 5, 6].map((n) => ({ label: `${n} teams`, value: n }));
const newPoolSize = ref<number | null>(null);

// Derived
const selectedPool = computed(() => pools.value.find((p) => p.id === selectedPoolId.value) || null);

const unassignedTeams = computed(() => {
  return teams.value
    .filter((t) => !t.pool_id)
    .slice()
    .sort((a, b) => a.full_team_name.localeCompare(b.full_team_name));
});

function teamsForPool(poolId: string) {
  return teams.value
    .filter((t) => t.pool_id === poolId)
    .slice()
    .sort((a, b) => {
      const sa = a.seed_in_pool ?? 9999;
      const sb = b.seed_in_pool ?? 9999;
      if (sa !== sb) return sa - sb;
      return a.full_team_name.localeCompare(b.full_team_name);
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
 * Migration assistance: flag pools that are not supported sizes (3–6).
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
    .filter((x) => x.size !== 0 && ![3, 4, 5, 6].includes(x.size));
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
    .select('id,full_team_name,pool_id,seed_in_pool,seed_global')
    .eq('tournament_id', session.tournament.id);
  if (error) {
    toast.add({ severity: 'error', summary: 'Failed to load teams', detail: error.message, life: 2500 });
    teams.value = [];
    return;
  }
  teams.value = (data || []) as Team[];
}

function normalizeKey(v: string): string {
  return normalizeCell(v).toLowerCase();
}

function buildTeamNameIndex(): { map: Map<string, Team>; duplicates: string[] } {
  const map = new Map<string, Team>();
  const dupes: string[] = [];
  for (const t of teams.value) {
    const name = normalizeCell(t.full_team_name || '');
    if (!name) continue;
    const key = normalizeKey(name);
    if (map.has(key)) {
      dupes.push(name);
      continue;
    }
    map.set(key, t);
  }
  return { map, duplicates: dupes };
}

function downloadPoolsTemplateCsv() {
  if (!session.tournament) {
    toast.add({ severity: 'warn', summary: 'Load a tournament first', life: 2000 });
    return;
  }
  if (teams.value.length === 0) {
    toast.add({ severity: 'warn', summary: 'No teams found', detail: 'Import teams first.', life: 2500 });
    return;
  }

  const ordered = teams.value.slice().sort((a, b) => {
    const ag = a.seed_global;
    const bg = b.seed_global;
    if (ag == null && bg == null) return (a.full_team_name || '').localeCompare((b.full_team_name || ''));
    if (ag == null) return 1;
    if (bg == null) return -1;
    if (ag !== bg) return ag - bg;
    return (a.full_team_name || '').localeCompare((b.full_team_name || ''));
  });

  const rows = ordered.map((t) => ({
    team_name: normalizeCell(t.full_team_name),
    pool_name: '',
    seed_in_pool: '',
    court_assignment: '',
  }));

  const csv = objectsToCsv(rows, ['team_name', 'pool_name', 'seed_in_pool', 'court_assignment']);
  const code = (session.accessCode || 'tournament').toLowerCase();
  downloadCsv(`pools_template_${code}.csv`, csv);
}

function resetPoolCsvInput() {
  if (poolCsvInput.value) poolCsvInput.value.value = '';
}

function getAny(rec: Record<string, string>, keys: string[]): string {
  for (const k of keys) {
    const v = rec[k];
    if (v != null && String(v).trim() !== '') return String(v);
  }
  return '';
}

function validatePoolImport(rowsRaw: Array<Record<string, string>>): { ok: boolean; rows: PoolImportRow[]; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  const { map: teamByName, duplicates: dupesInDb } = buildTeamNameIndex();
  if (dupesInDb.length > 0) {
    errors.push('Duplicate team names exist in the database. Resolve duplicates before importing pools.');
  }

  const requiredKeysPresent = (candidates: string[]) => rowsRaw.length === 0 ? false : candidates.some((k) => Object.prototype.hasOwnProperty.call(rowsRaw[0], k));
  if (!requiredKeysPresent(['team_name', 'full_team_name', 'team'])) {
    errors.push('CSV must include a team_name column.');
  }
  if (!requiredKeysPresent(['pool_name', 'pool'])) {
    errors.push('CSV must include a pool_name column.');
  }
  if (!requiredKeysPresent(['seed_in_pool', 'seed'])) {
    errors.push('CSV must include a seed_in_pool column.');
  }
  if (errors.length > 0) return { ok: false, rows: [], errors, warnings };

  const parsed: PoolImportRow[] = [];
  const seenTeams = new Set<string>();
  const seenSeedsByPool = new Map<string, Set<number>>();
  const poolCounts = new Map<string, number>();
  const courtByPool = new Map<string, Set<string>>();

  for (let i = 0; i < rowsRaw.length; i++) {
    const rec = rowsRaw[i];
    const rowNo = i + 2; // header is row 1
    const teamName = normalizeCell(getAny(rec, ['team_name', 'full_team_name', 'team']));
    const poolName = normalizeCell(getAny(rec, ['pool_name', 'pool']));
    const seedStr = normalizeCell(getAny(rec, ['seed_in_pool', 'seed']));
    const court = normalizeCell(getAny(rec, ['court_assignment', 'court']));

    if (!teamName) errors.push(`Row ${rowNo}: missing team_name`);
    if (!poolName) errors.push(`Row ${rowNo}: missing pool_name`);
    if (!seedStr) errors.push(`Row ${rowNo}: missing seed_in_pool`);

    const seed = Number(seedStr);
    if (!Number.isInteger(seed) || seed < 1) errors.push(`Row ${rowNo}: seed_in_pool must be a positive integer`);

    const teamKey = normalizeKey(teamName);
    if (teamName) {
      if (seenTeams.has(teamKey)) errors.push(`Row ${rowNo}: duplicate team_name '${teamName}' in file`);
      seenTeams.add(teamKey);
      if (!teamByName.has(teamKey)) errors.push(`Row ${rowNo}: team_name '${teamName}' not found in tournament`);
    }

    const poolKey = normalizeKey(poolName);
    if (poolName) {
      poolCounts.set(poolKey, (poolCounts.get(poolKey) ?? 0) + 1);
      if (court) {
        const set = courtByPool.get(poolKey) ?? new Set<string>();
        set.add(court);
        courtByPool.set(poolKey, set);
      }
    }

    if (poolName && Number.isInteger(seed) && seed >= 1) {
      const set = seenSeedsByPool.get(poolKey) ?? new Set<number>();
      if (set.has(seed)) errors.push(`Row ${rowNo}: duplicate seed_in_pool ${seed} in pool '${poolName}'`);
      set.add(seed);
      seenSeedsByPool.set(poolKey, set);
    }

    parsed.push({
      team_name: teamName,
      pool_name: poolName,
      seed_in_pool: Number.isInteger(seed) ? seed : 0,
      court_assignment: court ? court : null,
    });
  }

  // Seed range enforcement: seeds must be 1..pool_size (where pool_size = number of teams in that pool)
  for (const r of parsed) {
    if (!r.pool_name || !Number.isInteger(r.seed_in_pool) || r.seed_in_pool < 1) continue;
    const poolKey = normalizeKey(r.pool_name);
    const size = poolCounts.get(poolKey) ?? 0;
    if (size > 0 && (r.seed_in_pool < 1 || r.seed_in_pool > size)) {
      errors.push(`Pool '${r.pool_name}': seed_in_pool ${r.seed_in_pool} out of range (must be 1–${size})`);
    }
  }

  // Court assignment consistency warnings
  for (const [poolKey, courts] of courtByPool.entries()) {
    if (courts.size > 1) {
      const sample = Array.from(courts).slice(0, 5).join(', ');
      warnings.push(`Pool '${poolKey}': multiple court_assignment values found (${sample}). First non-empty will be used.`);
    }
  }

  return { ok: errors.length === 0, rows: parsed, errors, warnings };
}

async function handlePoolsCsvChange(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;

  try {
    const text = await file.text();
    const objs = csvToObjects(text);
    if (objs.length === 0) {
      poolImportRows.value = [];
      poolImportErrors.value = ['CSV appears to be empty.'];
      poolImportWarnings.value = [];
      poolImportSummary.value = { pools: 0, rows: 0, missingTeams: 0 };
      return;
    }

    const validated = validatePoolImport(objs);
    poolImportRows.value = validated.rows;
    poolImportErrors.value = validated.errors;
    poolImportWarnings.value = validated.warnings;

    const poolKeys = new Set(validated.rows.map((r) => normalizeKey(r.pool_name)).filter(Boolean));
    const teamKeysInFile = new Set(validated.rows.map((r) => normalizeKey(r.team_name)).filter(Boolean));
    const teamKeysInDb = new Set(teams.value.map((t) => normalizeKey(t.full_team_name || '')).filter(Boolean));
    let missingTeams = 0;
    for (const k of teamKeysInDb) {
      if (!teamKeysInFile.has(k)) missingTeams++;
    }

    poolImportSummary.value = { pools: poolKeys.size, rows: validated.rows.length, missingTeams };

    if (validated.ok) {
      toast.add({ severity: 'success', summary: 'CSV parsed', detail: `${validated.rows.length} row(s)`, life: 1500 });
      if (missingTeams > 0) {
        poolImportWarnings.value = poolImportWarnings.value.concat([`${missingTeams} team(s) are not included in the CSV and will remain unassigned after import.`]);
      }
    } else {
      toast.add({ severity: 'error', summary: 'CSV has issues', detail: `${validated.errors.length} error(s)`, life: 3500 });
    }
  } catch (err: any) {
    poolImportRows.value = [];
    poolImportErrors.value = [err?.message ?? 'Failed to parse CSV'];
    poolImportWarnings.value = [];
    poolImportSummary.value = { pools: 0, rows: 0, missingTeams: 0 };
    toast.add({ severity: 'error', summary: 'Parse failed', detail: err?.message ?? 'Unknown error', life: 3000 });
  } finally {
    resetPoolCsvInput();
  }
}

async function applyPoolsImport() {
  if (!session.tournament) {
    toast.add({ severity: 'warn', summary: 'Load a tournament first', life: 2000 });
    return;
  }
  if (poolImportRows.value.length === 0) {
    toast.add({ severity: 'warn', summary: 'No CSV loaded', life: 2000 });
    return;
  }
  if (poolImportErrors.value.length > 0) {
    toast.add({ severity: 'warn', summary: 'Fix CSV errors first', detail: `${poolImportErrors.value.length} error(s)`, life: 3000 });
    return;
  }

  const ok = confirm(
    'Import pools from CSV?\n\nThis will:\n- Delete ALL existing pool matches\n- Delete ALL existing pools\n- Clear ALL team pool assignments/seeds\n- Recreate pools and assignments from the CSV\n\nContinue?'
  );
  if (!ok) return;

  importing.value = true;
  try {
    const tournamentId = session.tournament.id;

    // 1) Delete existing pool matches
    {
      const { error } = await supabase
        .from('matches')
        .delete()
        .eq('tournament_id', tournamentId)
        .eq('match_type', 'pool');
      if (error) throw new Error(`Failed to delete pool matches: ${error.message}`);
    }

    // 2) Delete existing pools (teams unassigned via FK)
    {
      const { error } = await supabase
        .from('pools')
        .delete()
        .eq('tournament_id', tournamentId);
      if (error) throw new Error(`Failed to delete pools: ${error.message}`);
    }

    // 3) Clear team assignments
    {
      const { error } = await supabase
        .from('teams')
        .update({ pool_id: null, seed_in_pool: null })
        .eq('tournament_id', tournamentId);
      if (error) throw new Error(`Failed to reset team assignments: ${error.message}`);
    }

    // Build team index
    const { map: teamByName } = buildTeamNameIndex();

    // 4) Create pools
    const poolMeta = new Map<string, { name: string; court: string | null; size: number }>();
    for (const r of poolImportRows.value) {
      const key = normalizeKey(r.pool_name);
      const cur = poolMeta.get(key);
      if (!cur) {
        poolMeta.set(key, { name: r.pool_name, court: r.court_assignment ?? null, size: 1 });
      } else {
        cur.size += 1;
        if (!cur.court && r.court_assignment) cur.court = r.court_assignment;
      }
    }

    const poolPayload = Array.from(poolMeta.values()).map((p) => ({
      tournament_id: tournamentId,
      name: p.name,
      court_assignment: p.court,
      target_size: p.size,
    }));

    const { data: createdPools, error: insPErr } = await supabase
      .from('pools')
      .insert(poolPayload)
      .select('id,name');
    if (insPErr) throw new Error(`Failed to create pools: ${insPErr.message}`);

    const poolIdByKey = new Map<string, string>();
    for (const p of ((createdPools as any[]) ?? [])) {
      const name = normalizeCell(p.name || '');
      if (!name) continue;
      poolIdByKey.set(normalizeKey(name), String(p.id));
    }

    // 5) Assign teams in bulk by primary key upsert
    const updates = poolImportRows.value.map((r) => {
      const team = teamByName.get(normalizeKey(r.team_name));
      const pid = poolIdByKey.get(normalizeKey(r.pool_name));
      if (!team || !pid) return null;
      return { id: team.id, pool_id: pid, seed_in_pool: r.seed_in_pool };
    }).filter(Boolean) as Array<{ id: string; pool_id: string; seed_in_pool: number }>;

    const { error: upErr } = await supabase
      .from('teams')
      .upsert(updates, { onConflict: 'id' });
    if (upErr) throw new Error(`Failed to assign teams: ${upErr.message}`);

    await Promise.all([loadPools(), loadTeams()]);
    poolImportRows.value = [];
    poolImportErrors.value = [];
    poolImportWarnings.value = [];
    poolImportSummary.value = { pools: 0, rows: 0, missingTeams: 0 };
    toast.add({ severity: 'success', summary: 'Pools imported', detail: `Created ${poolPayload.length} pool(s)`, life: 2500 });
  } catch (err: any) {
    toast.add({ severity: 'error', summary: 'Import failed', detail: err?.message ?? 'Unknown error', life: 4000 });
  } finally {
    importing.value = false;
  }
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
  if (!newPoolSize.value || ![3, 4, 5, 6].includes(Number(newPoolSize.value))) {
    toast.add({ severity: 'warn', summary: 'Select a pool size (3–6)', life: 2000 });
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
      .select('id,full_team_name,seed_in_pool,pool_id,seed_global')
      .eq('tournament_id', tournamentId)
      .order('seed_global', { ascending: true })
      .order('full_team_name', { ascending: true });

    if (teamErr) throw new Error(`Load teams failed: ${teamErr.message}`);

    const ordered: Team[] = (teamRows as any[]).sort((a, b) => {
      const ag = a.seed_global;
      const bg = b.seed_global;
      if (ag == null && bg == null) return a.full_team_name.localeCompare(b.full_team_name);
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

    <!-- Import Pools (Google Sheets CSV) -->
    <div v-if="session.tournament" class="mt-4 rounded-lg border border-white/15 bg-white/5 p-4">
      <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div class="text-sm">
          <div class="font-semibold">Import Pools (Google Sheets CSV)</div>
          <div class="mt-1 text-white/80">
            Download the template CSV, import it into Google Sheets, fill <span class="font-mono">pool_name</span> / <span class="font-mono">seed_in_pool</span> (optional <span class="font-mono">court_assignment</span>), then export CSV and upload here.
          </div>
          <div class="mt-2 text-xs text-white/70">
            Google Sheets: File → Import (CSV) • then File → Download → Comma-separated values (.csv)
          </div>
        </div>
        <div class="flex items-center gap-2">
          <Button
            label="Download Template CSV"
            icon="pi pi-download"
            class="!rounded-xl border-none text-white gbv-grad-blue"
            @click="downloadPoolsTemplateCsv"
          />
        </div>
      </div>

      <div class="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 sm:items-end">
        <div>
          <label class="block text-sm mb-2">Upload Pools CSV</label>
          <input
            ref="poolCsvInput"
            type="file"
            accept=".csv,text/csv"
            class="w-full rounded-xl border border-white/30 bg-white px-4 py-3 text-slate-900"
            @change="handlePoolsCsvChange"
          />
          <div v-if="poolImportSummary.rows > 0" class="mt-2 text-xs text-white/80">
            Parsed: {{ poolImportSummary.rows }} row(s), {{ poolImportSummary.pools }} pool(s)
            <span v-if="poolImportSummary.missingTeams > 0"> • Missing teams: {{ poolImportSummary.missingTeams }}</span>
          </div>
        </div>

        <div class="flex sm:justify-end">
          <Button
            :loading="importing"
            :disabled="poolImportRows.length === 0 || poolImportErrors.length > 0"
            label="Apply Import (Replace)"
            icon="pi pi-upload"
            severity="danger"
            class="!rounded-xl"
            @click="applyPoolsImport"
          />
        </div>
      </div>

      <div v-if="poolImportErrors.length > 0" class="mt-4 rounded-lg border border-amber-300 bg-amber-400/10 p-3 text-amber-100 text-sm">
        <div class="font-semibold mb-1">CSV Errors (fix before applying)</div>
        <ul class="list-disc list-inside">
          <li v-for="(e, idx) in poolImportErrors" :key="idx">{{ e }}</li>
        </ul>
      </div>

      <div v-if="poolImportWarnings.length > 0" class="mt-3 rounded-lg border border-white/15 bg-white/5 p-3 text-white/90 text-sm">
        <div class="font-semibold mb-1">Warnings</div>
        <ul class="list-disc list-inside text-white/80">
          <li v-for="(w, idx) in poolImportWarnings" :key="idx">{{ w }}</li>
        </ul>
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
          {{ ip.pool.name }} has {{ ip.size }} team(s). Adjust to 3–6 before generating the schedule.
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
                placeholder="Pool size (3–6)"
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
                    <div class="font-medium">{{ t.full_team_name }}</div>
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
                      <div class="font-medium">{{ t.full_team_name }}</div>
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
