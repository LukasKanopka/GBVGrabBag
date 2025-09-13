<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useToast } from 'primevue/usetoast';
import InputText from 'primevue/inputtext';
import Dropdown from 'primevue/dropdown';
import Button from 'primevue/button';
import DataTable from 'primevue/datatable';
import Column from 'primevue/column';
import InputNumber from 'primevue/inputnumber';
import ToggleButton from 'primevue/togglebutton';
import supabase from '../lib/supabase';
import type { Tournament, TournamentStatus, AdvancementRules, GameRules } from '../types/db';

type EditableTournament = {
  id: string | null;
  name: string;
  date: string; // ISO (YYYY-MM-DD)
  access_code: string;
  status: TournamentStatus;
  advancement_rules: AdvancementRules;
  game_rules: GameRules;
  bracket_started: boolean;
  bracket_generated_at: string | null;
};

const router = useRouter();
const toast = useToast();

const loading = ref(false);
const saving = ref(false);
const tournaments = ref<Tournament[]>([]);
const selectedId = ref<string | null>(null);

const statusOptions: { label: string; value: TournamentStatus }[] = [
  { label: 'Draft', value: 'draft' },
  { label: 'Setup', value: 'setup' },
  { label: 'Pool Play', value: 'pool_play' },
  { label: 'Bracket', value: 'bracket' },
  { label: 'Completed', value: 'completed' },
];

// Defaults per Bundle C
const DEFAULT_ADV_RULES: AdvancementRules = {
  pools: [
    { fromPoolSize: 3, advanceCount: 2 },
    { fromPoolSize: 4, advanceCount: 2 },
    { fromPoolSize: 5, advanceCount: 2 },
  ],
  bracketFormat: 'single_elimination',
  tiebreakers: ['head_to_head', 'set_ratio', 'point_diff', 'random'],
};

const DEFAULT_GAME_RULES: GameRules = {
  pool: { setTarget: 21, cap: 25, bestOf: 1, winBy2: true },
  bracket: { setTarget: 21, cap: 25, bestOf: 1, winBy2: true, thirdSetTarget: 15 },
};

const form = ref<EditableTournament>({
  id: null,
  name: '',
  date: '',
  access_code: '',
  status: 'draft',
  advancement_rules: structuredClone(DEFAULT_ADV_RULES),
  game_rules: structuredClone(DEFAULT_GAME_RULES),
  bracket_started: false,
  bracket_generated_at: null,
});


function toForm(t: Tournament | null) {
  if (!t) {
    form.value = {
      id: null,
      name: '',
      date: '',
      access_code: '',
      status: 'draft',
      advancement_rules: structuredClone(DEFAULT_ADV_RULES),
      game_rules: structuredClone(DEFAULT_GAME_RULES),
      bracket_started: false,
      bracket_generated_at: null,
    };
    return;
  }
  form.value = {
    id: t.id,
    name: t.name,
    date: t.date,
    access_code: t.access_code,
    status: t.status,
    advancement_rules: normalizeAdvancementRules(t.advancement_rules),
    game_rules: normalizeGameRules(t.game_rules),
    bracket_started: (t as any).bracket_started ?? false,
    bracket_generated_at: (t as any).bracket_generated_at ?? null,
  };
}

function normalizeAdvancementRules(r: AdvancementRules | null | undefined): AdvancementRules {
  const base = structuredClone(DEFAULT_ADV_RULES);
  if (!r) return base;
  const next: AdvancementRules = {
    pools: Array.isArray(r.pools) ? r.pools.slice() : base.pools!.slice(),
    bracketFormat: r.bracketFormat ?? base.bracketFormat,
    tiebreakers: (r.tiebreakers?.length ? r.tiebreakers : base.tiebreakers) as any,
  };
  ensurePoolsConfig(next);
  return next;
}

function normalizeGameRules(r: GameRules | null | undefined): GameRules {
  const base = structuredClone(DEFAULT_GAME_RULES);
  if (!r) return base;
  return {
    pool: {
      setTarget: r.pool?.setTarget ?? base.pool!.setTarget,
      cap: r.pool?.cap ?? base.pool!.cap,
      bestOf: r.pool?.bestOf ?? base.pool!.bestOf,
      winBy2: r.pool?.winBy2 ?? base.pool!.winBy2,
    },
    bracket: {
      setTarget: r.bracket?.setTarget ?? base.bracket!.setTarget,
      cap: r.bracket?.cap ?? base.bracket!.cap,
      bestOf: r.bracket?.bestOf ?? base.bracket!.bestOf,
      winBy2: r.bracket?.winBy2 ?? base.bracket!.winBy2,
      thirdSetTarget: r.bracket?.thirdSetTarget ?? base.bracket!.thirdSetTarget,
    },
  };
}

async function loadTournaments() {
  loading.value = true;
  try {
    const { data, error } = await supabase
      .from('tournaments')
      .select('*')
      .order('date', { ascending: false });
    if (error) {
      toast.add({ severity: 'error', summary: 'Load failed', detail: error.message, life: 3000 });
      tournaments.value = [];
      return;
    }
    tournaments.value = (data || []) as Tournament[];
  } finally {
    loading.value = false;
  }
}

function newTournament() {
  selectedId.value = null;
  toForm(null);
}

function selectTournament(t: Tournament) {
  selectedId.value = t.id;
  toForm(t);
}

// Helpers — Advancement UI

type Tiebreaker = 'head_to_head' | 'set_ratio' | 'point_diff' | 'random';
function formatTb(tb: Tiebreaker): string { return String(tb).replace(/_/g, ' '); }

function ensurePoolsConfig(rules: AdvancementRules) {
  const sizes = [3, 4, 5];
  if (!Array.isArray(rules.pools)) rules.pools = [];
  for (const s of sizes) {
    const existing = rules.pools!.find((p) => p.fromPoolSize === s);
    if (!existing) rules.pools!.push({ fromPoolSize: s, advanceCount: s === 5 ? 2 : 2 });
  }
  // sort by size asc
  rules.pools!.sort((a, b) => a.fromPoolSize - b.fromPoolSize);
}

function getAdvanceCount(size: number): number {
  ensurePoolsConfig(form.value.advancement_rules);
  const found = form.value.advancement_rules.pools!.find((p) => p.fromPoolSize === size);
  return found?.advanceCount ?? 0;
}

function setAdvanceCount(size: number, value: number) {
  ensurePoolsConfig(form.value.advancement_rules);
  const max = size;
  const val = Math.max(0, Math.min(max, Number(value) || 0));
  const found = form.value.advancement_rules.pools!.find((p) => p.fromPoolSize === size);
  if (found) found.advanceCount = val;
}

const tiebreakerOptions: Tiebreaker[] = [
  'head_to_head',
  'set_ratio',
  'point_diff',
  'random',
];

function moveTiebreaker(idx: number, dir: -1 | 1) {
  const list = form.value.advancement_rules.tiebreakers || [];
  const i = idx;
  const j = i + dir;
  if (j < 0 || j >= list.length) return;
  const tmp = list[i]!;
  list[i] = list[j]!;
  list[j] = tmp;
  form.value.advancement_rules.tiebreakers = list.slice();
}

function toggleTiebreaker(v: Tiebreaker) {
  const list = (form.value.advancement_rules.tiebreakers || []) as Tiebreaker[];
  const i = list.indexOf(v);
  if (i >= 0) {
    list.splice(i, 1);
  } else {
    list.push(v);
  }
  form.value.advancement_rules.tiebreakers = list.slice();
}

// Validation and persistence

function validateForm() {
  if (!form.value.name.trim()) throw new Error('Name is required');
  if (!form.value.date.trim()) throw new Error('Date is required (YYYY-MM-DD)');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.value.date.trim())) {
    throw new Error('Date must be YYYY-MM-DD');
  }
  if (!form.value.access_code.trim()) throw new Error('Access code is required');

  // Advancement rules sanity
  ensurePoolsConfig(form.value.advancement_rules);
  const tb = form.value.advancement_rules.tiebreakers || [];
  if (tb.length === 0) throw new Error('At least one tiebreaker is required');
  if (!form.value.advancement_rules.bracketFormat) throw new Error('Bracket format is required');

  // Game rules sanity
  const gr = form.value.game_rules;
  const phases: Array<keyof GameRules> = ['pool', 'bracket'];
  for (const ph of phases) {
    const r: any = (gr as any)[ph] || {};
    ['setTarget', 'cap', 'bestOf'].forEach((k) => {
      if (r[k] == null || Number(r[k]) <= 0) {
        throw new Error(`Game rules (${ph}) require ${k}`);
      }
    });
    if (ph === 'bracket' && r.bestOf === 3) {
      if (r.thirdSetTarget == null || Number(r.thirdSetTarget) <= 0) {
        throw new Error('Game rules (bracket) require thirdSetTarget when bestOf = 3');
      }
    }
  }
}

async function saveTournament() {
  try {
    validateForm();
  } catch (err: any) {
    toast.add({ severity: 'warn', summary: 'Validation', detail: err.message, life: 3000 });
    return;
  }

  const payload: any = {
    name: form.value.name.trim(),
    date: form.value.date.trim(),
    access_code: form.value.access_code.trim(),
    status: form.value.status,
    advancement_rules: form.value.advancement_rules,
    game_rules: form.value.game_rules,
  };

  // Preserve bracket flags only via DB-generated logic; allow manual override here only if present
  if (typeof form.value.bracket_started === 'boolean') payload.bracket_started = form.value.bracket_started;
  payload.bracket_generated_at = form.value.bracket_generated_at;

  saving.value = true;
  try {
    if (form.value.id) {
      const { error } = await supabase.from('tournaments').update(payload).eq('id', form.value.id);
      if (error) throw error;
      toast.add({ severity: 'success', summary: 'Tournament updated', life: 1500 });
    } else {
      const { data, error } = await supabase.from('tournaments').insert(payload).select('*').single();
      if (error) throw error;
      toast.add({ severity: 'success', summary: 'Tournament created', life: 1500 });
      if (data) {
        selectedId.value = (data as Tournament).id;
      }
    }
    await loadTournaments();
    // Re-select to reflect persisted state
    if (selectedId.value) {
      const t = tournaments.value.find((x) => x.id === selectedId.value) || null;
      toForm(t);
    }
  } catch (err: any) {
    toast.add({ severity: 'error', summary: 'Save failed', detail: err?.message ?? 'Unknown error', life: 3500 });
  } finally {
    saving.value = false;
  }
}

async function deleteTournament() {
  if (!form.value.id) return;
  const ok = confirm('Delete this tournament? This cannot be undone.');
  if (!ok) return;
  saving.value = true;
  try {
    const { error } = await supabase.from('tournaments').delete().eq('id', form.value.id);
    if (error) throw error;
    toast.add({ severity: 'success', summary: 'Tournament deleted', life: 1500 });
    await loadTournaments();
    newTournament();
  } catch (err: any) {
    toast.add({ severity: 'error', summary: 'Delete failed', detail: err?.message ?? 'Unknown error', life: 3500 });
  } finally {
    saving.value = false;
  }
}

onMounted(async () => {
  await loadTournaments();
});
</script>

<template>
  <section class="mx-auto max-w-6xl px-4 pb-10 pt-6">
    <div class="rounded-2xl border border-slate-200 bg-white shadow-lg">
      <div class="p-5 sm:p-7">
        <div class="flex items-center justify-between gap-3">
          <div>
            <h2 class="text-2xl font-semibold text-slate-900">Tournament Setup</h2>
            <p class="mt-1 text-slate-600">
              Create and edit tournaments, rules, and status.
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

        <div class="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-3">
          <!-- Left: Tournaments list -->
          <div class="sm:col-span-1">
            <div class="flex items-center justify-between">
              <h3 class="text-lg font-semibold text-slate-900">Tournaments</h3>
              <Button
                label="New"
                icon="pi pi-plus"
                class="!rounded-xl border-none text-white gbv-grad-blue"
                @click="newTournament"
              />
            </div>

            <div class="mt-3">
              <DataTable
                :value="tournaments"
                size="small"
                class="rounded-xl overflow-hidden"
                :loading="loading"
                tableClass="!text-sm"
              >
                <Column field="name" header="Name">
                  <template #body="{ data }">
                    <div class="font-medium">{{ data.name }}</div>
                    <div class="text-xs text-slate-500">{{ data.date }} • {{ data.status }}</div>
                  </template>
                </Column>
                <Column header="" style="width: 5rem">
                  <template #body="{ data }">
                    <Button label="Edit" size="small" text @click="selectTournament(data)" />
                  </template>
                </Column>
              </DataTable>
            </div>
          </div>

          <!-- Right: Editor -->
          <div class="sm:col-span-2">
            <!-- Basics -->
            <div class="rounded-xl bg-gbv-bg p-4">
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label class="block text-sm font-medium text-slate-700 mb-2">Name</label>
                  <InputText v-model="form.name" class="w-full !rounded-xl !px-4 !py-3" placeholder="e.g. Fall Classic 2025" />
                </div>
                <div>
                  <label class="block text-sm font-medium text-slate-700 mb-2">Date (YYYY-MM-DD)</label>
                  <InputText v-model="form.date" class="w-full !rounded-xl !px-4 !py-3" placeholder="2025-10-12" />
                </div>
                <div>
                  <label class="block text-sm font-medium text-slate-700 mb-2">Access Code</label>
                  <InputText v-model="form.access_code" class="w-full !rounded-xl !px-4 !py-3" placeholder="GATORS2025" />
                </div>
                <div>
                  <label class="block text-sm font-medium text-slate-700 mb-2">Status</label>
                  <Dropdown
                    v-model="form.status"
                    :options="statusOptions"
                    optionLabel="label"
                    optionValue="value"
                    class="w-full !rounded-xl"
                    :pt="{ input: { class: '!py-3 !px-4 !text-base !rounded-xl' } }"
                  />
                </div>
              </div>
            </div>

            <!-- Rules -->
            <div class="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-2">
              <!-- Advancement Rules -->
              <div class="rounded-xl bg-gbv-bg p-4">
                <div class="flex items-center justify-between">
                  <label class="block text-sm font-semibold text-slate-700">Advancement Rules</label>
                </div>

                <div class="mt-3 space-y-3">
                  <div class="rounded-lg border border-slate-200 bg-white p-3">
                    <div class="text-sm font-medium text-slate-800 mb-2">Advancers per Pool Size</div>
                    <div class="grid grid-cols-1 gap-3">
                      <div class="flex items-center justify-between gap-3">
                        <div class="text-sm text-slate-700">3 teams</div>
                        <Dropdown
                          :options="[0,1,2,3]"
                          :modelValue="getAdvanceCount(3)"
                          @update:modelValue="(v:any) => setAdvanceCount(3, v)"
                          class="!rounded-xl w-32"
                          :pt="{ input: { class: '!py-2 !px-3 !text-sm !rounded-xl' } }"
                        />
                      </div>
                      <div class="flex items-center justify-between gap-3">
                        <div class="text-sm text-slate-700">4 teams</div>
                        <Dropdown
                          :options="[0,1,2,3,4]"
                          :modelValue="getAdvanceCount(4)"
                          @update:modelValue="(v:any) => setAdvanceCount(4, v)"
                          class="!rounded-xl w-32"
                          :pt="{ input: { class: '!py-2 !px-3 !text-sm !rounded-xl' } }"
                        />
                      </div>
                      <div class="flex items-center justify-between gap-3">
                        <div class="text-sm text-slate-700">5 teams</div>
                        <Dropdown
                          :options="[0,1,2,3,4,5]"
                          :modelValue="getAdvanceCount(5)"
                          @update:modelValue="(v:any) => setAdvanceCount(5, v)"
                          class="!rounded-xl w-32"
                          :pt="{ input: { class: '!py-2 !px-3 !text-sm !rounded-xl' } }"
                        />
                      </div>
                    </div>
                  </div>

                  <div class="rounded-lg border border-slate-200 bg-white p-3">
                    <div class="text-sm font-medium text-slate-800 mb-2">Bracket Format</div>
                    <Dropdown
                      v-model="form.advancement_rules.bracketFormat"
                      :options="[
                        { label: 'Single Elimination', value: 'single_elimination' },
                        { label: 'Best-of-3 Single Elim (Finals)', value: 'best_of_3_single_elim' }
                      ]"
                      optionLabel="label"
                      optionValue="value"
                      class="w-full !rounded-xl"
                      :pt="{ input: { class: '!py-2 !px-3 !text-sm !rounded-xl' } }"
                    />
                  </div>

                  <div class="rounded-lg border border-slate-200 bg-white p-3">
                    <div class="text-sm font-medium text-slate-800 mb-2">Tiebreakers (drag order using arrows)</div>
                    <ul class="space-y-2">
                      <li
                        v-for="(tb, idx) in (form.advancement_rules.tiebreakers || [])"
                        :key="tb"
                        class="flex items-center justify-between rounded-md border border-slate-200 bg-white p-2"
                      >
                        <div class="text-sm font-medium text-slate-800 capitalize">
                          {{ formatTb(tb as any) }}
                        </div>
                        <div class="flex items-center gap-1">
                          <Button icon="pi pi-arrow-up" text rounded @click="moveTiebreaker(idx, -1)" />
                          <Button icon="pi pi-arrow-down" text rounded @click="moveTiebreaker(idx, 1)" />
                        </div>
                      </li>
                    </ul>
                    <div class="mt-3 flex flex-wrap gap-2">
                      <Button
                        v-for="opt in tiebreakerOptions"
                        :key="opt"
                        :label="(((form.advancement_rules.tiebreakers || []) as Tiebreaker[]).includes(opt) ? 'Remove ' : 'Add ') + formatTb(opt as any)"
                        size="small"
                        :severity="((form.advancement_rules.tiebreakers || []) as Tiebreaker[]).includes(opt) ? 'danger' : 'secondary'"
                        outlined
                        class="!rounded-xl"
                        @click="toggleTiebreaker(opt)"
                      />
                    </div>
                  </div>
                </div>
              </div>

              <!-- Game Rules -->
              <div class="rounded-xl bg-gbv-bg p-4">
                <div class="flex items-center justify-between">
                  <label class="block text-sm font-semibold text-slate-700">Game Rules</label>
                </div>

                <div class="mt-3 grid grid-cols-1 gap-4">
                  <div class="rounded-lg border border-slate-200 bg-white p-3">
                    <div class="text-sm font-semibold text-slate-900">Pool Play</div>
                    <div class="mt-3 grid grid-cols-2 gap-3">
                      <div>
                        <label class="block text-xs text-slate-600 mb-1">Set Target</label>
                        <InputNumber v-model="form.game_rules.pool!.setTarget" :min="1" class="w-full" :pt="{ input: { class: '!w-full !py-2 !px-3 !rounded-xl' } }" />
                      </div>
                      <div>
                        <label class="block text-xs text-slate-600 mb-1">Cap</label>
                        <InputNumber v-model="form.game_rules.pool!.cap" :min="1" class="w-full" :pt="{ input: { class: '!w-full !py-2 !px-3 !rounded-xl' } }" />
                      </div>
                      <div>
                        <label class="block text-xs text-slate-600 mb-1">Best Of</label>
                        <Dropdown
                          v-model="form.game_rules.pool!.bestOf"
                          :options="[1,3]"
                          class="w-full !rounded-xl"
                          :pt="{ input: { class: '!py-2 !px-3 !text-sm !rounded-xl' } }"
                        />
                      </div>
                      <div class="flex items-end">
                        <div class="flex items-center gap-2">
                          <span class="text-sm text-slate-700">Win by 2</span>
                          <ToggleButton v-model="form.game_rules.pool!.winBy2" onLabel="Yes" offLabel="No" />
                        </div>
                      </div>
                    </div>
                  </div>

                  <div class="rounded-lg border border-slate-200 bg-white p-3">
                    <div class="text-sm font-semibold text-slate-900">Bracket</div>
                    <div class="mt-3 grid grid-cols-2 gap-3">
                      <div>
                        <label class="block text-xs text-slate-600 mb-1">Set Target</label>
                        <InputNumber v-model="form.game_rules.bracket!.setTarget" :min="1" class="w-full" :pt="{ input: { class: '!w-full !py-2 !px-3 !rounded-xl' } }" />
                      </div>
                      <div>
                        <label class="block text-xs text-slate-600 mb-1">Cap</label>
                        <InputNumber v-model="form.game_rules.bracket!.cap" :min="1" class="w-full" :pt="{ input: { class: '!w-full !py-2 !px-3 !rounded-xl' } }" />
                      </div>
                      <div>
                        <label class="block text-xs text-slate-600 mb-1">Best Of</label>
                        <Dropdown
                          v-model="form.game_rules.bracket!.bestOf"
                          :options="[1,3]"
                          class="w-full !rounded-xl"
                          :pt="{ input: { class: '!py-2 !px-3 !text-sm !rounded-xl' } }"
                        />
                      </div>
                      <div class="flex items-end">
                        <div class="flex items-center gap-2">
                          <span class="text-sm text-slate-700">Win by 2</span>
                          <ToggleButton v-model="form.game_rules.bracket!.winBy2" onLabel="Yes" offLabel="No" />
                        </div>
                      </div>
                      <div v-if="form.game_rules.bracket!.bestOf === 3">
                        <label class="block text-xs text-slate-600 mb-1">Third Set Target</label>
                        <InputNumber v-model="form.game_rules.bracket!.thirdSetTarget" :min="1" class="w-full" :pt="{ input: { class: '!w-full !py-2 !px-3 !rounded-xl' } }" />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <!-- Bracket flags -->
            <div class="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-2">
              <div class="rounded-xl border border-slate-200 p-4">
                <div class="text-sm text-slate-700">Bracket Started</div>
                <div class="mt-1 font-semibold">{{ form.bracket_started ? 'Yes' : 'No' }}</div>
                <div class="mt-2 text-xs text-slate-500">Generated at: {{ form.bracket_generated_at || '—' }}</div>
                <div class="mt-2 text-xs text-slate-500">Note: This is managed by the bracket engine.</div>
              </div>
            </div>

            <!-- Actions -->
            <div class="mt-6 flex items-center gap-3">
              <Button
                :loading="saving"
                label="Save"
                icon="pi pi-save"
                class="!rounded-xl border-none text-white gbv-grad-blue"
                @click="saveTournament"
              />
              <Button
                v-if="form.id"
                :loading="saving"
                label="Delete"
                icon="pi pi-trash"
                severity="danger"
                class="!rounded-xl"
                @click="deleteTournament"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>