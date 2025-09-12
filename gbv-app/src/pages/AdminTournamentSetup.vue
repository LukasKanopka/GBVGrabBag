<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useToast } from 'primevue/usetoast';
import InputText from 'primevue/inputtext';
import Textarea from 'primevue/textarea';
import Dropdown from 'primevue/dropdown';
import Button from 'primevue/button';
import DataTable from 'primevue/datatable';
import Column from 'primevue/column';
import supabase from '../lib/supabase';
import type { Tournament, TournamentStatus, AdvancementRules, GameRules } from '../types/db';

type EditableTournament = {
  id: string | null;
  name: string;
  date: string; // ISO (YYYY-MM-DD)
  access_code: string;
  status: TournamentStatus;
  advancement_rules_text: string;
  game_rules_text: string;
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

const form = ref<EditableTournament>({
  id: null,
  name: '',
  date: '',
  access_code: '',
  status: 'draft',
  advancement_rules_text: JSON.stringify(
    {
      pools: [
        { fromPoolSize: 3, advanceCount: 2 },
        { fromPoolSize: 4, advanceCount: 2 },
        { fromPoolSize: 5, advanceCount: 2 },
      ],
      bracketFormat: 'single_elimination',
      tiebreakers: ['head_to_head', 'set_ratio', 'point_diff', 'random'],
    } as AdvancementRules,
    null,
    2
  ),
  game_rules_text: JSON.stringify(
    {
      pool: { setTarget: 21, cap: 25, bestOf: 1 },
      bracket: { setTarget: 21, cap: 25, bestOf: 1 },
    } as GameRules,
    null,
    2
  ),
  bracket_started: false,
  bracket_generated_at: null,
});

const selectedTournament = computed(() => tournaments.value.find((t) => t.id === selectedId.value) || null);

function toForm(t: Tournament | null) {
  if (!t) {
    form.value = {
      id: null,
      name: '',
      date: '',
      access_code: '',
      status: 'draft',
      advancement_rules_text: JSON.stringify(
        {
          pools: [
            { fromPoolSize: 3, advanceCount: 2 },
            { fromPoolSize: 4, advanceCount: 2 },
            { fromPoolSize: 5, advanceCount: 2 },
          ],
          bracketFormat: 'single_elimination',
          tiebreakers: ['head_to_head', 'set_ratio', 'point_diff', 'random'],
        } as AdvancementRules,
        null,
        2
      ),
      game_rules_text: JSON.stringify(
        {
          pool: { setTarget: 21, cap: 25, bestOf: 1 },
          bracket: { setTarget: 21, cap: 25, bestOf: 1 },
        } as GameRules,
        null,
        2
      ),
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
    advancement_rules_text: JSON.stringify(t.advancement_rules ?? {}, null, 2),
    game_rules_text: JSON.stringify(t.game_rules ?? {}, null, 2),
    bracket_started: (t as any).bracket_started ?? false,
    bracket_generated_at: (t as any).bracket_generated_at ?? null,
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

function parseJsonOrError(text: string, label: string) {
  if (!text || !text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch (err: any) {
    throw new Error(`${label} JSON invalid: ${err?.message || 'Parse error'}`);
  }
}

function validateForm() {
  if (!form.value.name.trim()) throw new Error('Name is required');
  if (!form.value.date.trim()) throw new Error('Date is required (YYYY-MM-DD)');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.value.date.trim())) {
    throw new Error('Date must be YYYY-MM-DD');
  }
  if (!form.value.access_code.trim()) throw new Error('Access code is required');
  // Validate JSONs
  parseJsonOrError(form.value.advancement_rules_text, 'Advancement Rules');
  parseJsonOrError(form.value.game_rules_text, 'Game Rules');
}

async function saveTournament() {
  try {
    validateForm();
  } catch (err: any) {
    toast.add({ severity: 'warn', summary: 'Validation', detail: err.message, life: 3000 });
    return;
  }

  const advancement_rules = parseJsonOrError(form.value.advancement_rules_text, 'Advancement Rules');
  const game_rules = parseJsonOrError(form.value.game_rules_text, 'Game Rules');

  const payload: any = {
    name: form.value.name.trim(),
    date: form.value.date.trim(),
    access_code: form.value.access_code.trim(),
    status: form.value.status,
    advancement_rules,
    game_rules,
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

          <div class="sm:col-span-2">
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

            <div class="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-2">
              <div class="rounded-xl bg-gbv-bg p-4">
                <div class="flex items-center justify-between">
                  <label class="block text-sm font-semibold text-slate-700">Advancement Rules (JSON)</label>
                  <Button label="Format" text size="small" @click="form.advancement_rules_text = JSON.stringify(JSON.parse(form.advancement_rules_text || '{}'), null, 2)" />
                </div>
                <Textarea
                  v-model="form.advancement_rules_text"
                  autoResize
                  rows="10"
                  class="w-full !rounded-xl"
                  placeholder='{ "pools": [ { "fromPoolSize": 4, "advanceCount": 2 } ], "bracketFormat": "single_elimination", "tiebreakers": ["head_to_head","set_ratio","point_diff","random"] }'
                />
              </div>

              <div class="rounded-xl bg-gbv-bg p-4">
                <div class="flex items-center justify-between">
                  <label class="block text-sm font-semibold text-slate-700">Game Rules (JSON)</label>
                  <Button label="Format" text size="small" @click="form.game_rules_text = JSON.stringify(JSON.parse(form.game_rules_text || '{}'), null, 2)" />
                </div>
                <Textarea
                  v-model="form.game_rules_text"
                  autoResize
                  rows="10"
                  class="w-full !rounded-xl"
                  placeholder='{ "pool": { "setTarget": 21, "cap": 25, "bestOf": 1 }, "bracket": { "setTarget": 21, "cap": 25, "bestOf": 3 } }'
                />
              </div>
            </div>

            <div class="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-2">
              <div class="rounded-xl border border-slate-200 p-4">
                <div class="text-sm text-slate-700">Bracket Started</div>
                <div class="mt-1 font-semibold">{{ form.bracket_started ? 'Yes' : 'No' }}</div>
                <div class="mt-2 text-xs text-slate-500">Generated at: {{ form.bracket_generated_at || '—' }}</div>
                <div class="mt-2 text-xs text-slate-500">Note: This is managed by the bracket engine.</div>
              </div>
            </div>

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