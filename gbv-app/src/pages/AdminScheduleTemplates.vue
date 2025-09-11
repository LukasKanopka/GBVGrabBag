<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useSessionStore } from '../stores/session';
import supabase from '../lib/supabase';
import Button from 'primevue/button';
import Dropdown from 'primevue/dropdown';
import InputText from 'primevue/inputtext';
import Textarea from 'primevue/textarea';
import DataTable from 'primevue/datatable';
import Column from 'primevue/column';
import { useToast } from 'primevue/usetoast';

type RoundRow = {
  round: number;
  play: string; // JSON: e.g., [[1,2],[3,4]]
  ref?: string; // JSON: e.g., [3,4]
  sit?: string; // JSON: e.g., [5]
};

const toast = useToast();
const router = useRouter();
const session = useSessionStore();

const accessCode = ref<string>(session.accessCode ?? '');
const selectedPoolSize = ref<number | null>(null);
const poolSizeOptions = [3, 4, 5, 6, 7, 8].map((n) => ({ label: `${n} teams`, value: n }));
const templateRows = ref<RoundRow[]>([]);

const rowErrors = computed(() =>
  templateRows.value.map((r) => ({
    play: isValidJson(r.play) ? null : 'Invalid JSON',
    ref: isValidJson(r.ref) ? null : 'Invalid JSON',
    sit: isValidJson(r.sit) ? null : 'Invalid JSON',
  })),
);

const loading = ref(false);
const saving = ref(false);

function isValidJson(s?: string) {
  if (s == null || s.trim() === '') return true;
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) || typeof v === 'object';
  } catch {
    return false;
  }
}

function addRound() {
  const last = templateRows.value.length ? templateRows.value[templateRows.value.length - 1] : null;
  const nextRound = ((last && last.round) ? last.round : 0) + 1;
  templateRows.value.push({ round: nextRound, play: '[]', ref: '[]', sit: '[]' });
}

function removeRound(round: number) {
  templateRows.value = templateRows.value.filter((r) => r.round !== round);
}

function moveRound(round: number, dir: -1 | 1) {
  const idx = templateRows.value.findIndex((r) => r.round === round);
  if (idx < 0) return;
  const newIdx = idx + dir;
  if (newIdx < 0 || newIdx >= templateRows.value.length) return;
  const tmp = templateRows.value[idx];
  templateRows.value[idx] = templateRows.value[newIdx];
  templateRows.value[newIdx] = tmp;
  // Re-number rounds for clarity
  templateRows.value = templateRows.value.map((r, i) => ({ ...r, round: i + 1 }));
}

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
      return;
    }
    toast.add({ severity: 'success', summary: 'Tournament loaded', detail: t.name, life: 1500 });
    if (selectedPoolSize.value) await loadTemplate();
  } finally {
    loading.value = false;
  }
}

async function loadTemplate() {
  if (!session.tournament || !selectedPoolSize.value) {
    templateRows.value = [];
    return;
  }
  loading.value = true;
  try {
    const { data, error } = await supabase
      .from('schedule_templates')
      .select('template_data')
      .eq('tournament_id', session.tournament.id)
      .eq('pool_size', selectedPoolSize.value)
      .maybeSingle();
    if (error) {
      toast.add({ severity: 'error', summary: 'Load failed', detail: error.message, life: 2500 });
      templateRows.value = [];
      return;
    }
    if (!data || !data.template_data || !Array.isArray(data.template_data)) {
      templateRows.value = [];
      return;
    }
    // map to editable rows
    templateRows.value = (data.template_data as any[]).map((r: any) => ({
      round: r.round,
      play: JSON.stringify(r.play ?? []),
      ref: r.ref ? JSON.stringify(r.ref) : '[]',
      sit: r.sit ? JSON.stringify(r.sit) : '[]',
    }));
  } finally {
    loading.value = false;
  }
}

async function saveTemplate() {
  if (!session.tournament) {
    toast.add({ severity: 'warn', summary: 'Load a tournament first', life: 2000 });
    return;
  }
  if (!selectedPoolSize.value) {
    toast.add({ severity: 'warn', summary: 'Select pool size', life: 2000 });
    return;
  }
  const anyInvalid = rowErrors.value.some((e) => e.play || e.ref || e.sit);
  if (anyInvalid) {
    toast.add({ severity: 'error', summary: 'Fix invalid JSON rows', life: 2500 });
    return;
  }
  const template = templateRows.value.map((r) => ({
    round: r.round,
    play: r.play ? JSON.parse(r.play) : [],
    ref: r.ref ? JSON.parse(r.ref) : [],
    sit: r.sit ? JSON.parse(r.sit) : [],
  }));

  saving.value = true;
  try {
    const payload = {
      tournament_id: session.tournament.id,
      pool_size: selectedPoolSize.value,
      template_data: template,
    };
    const { error } = await supabase
      .from('schedule_templates')
      .upsert(payload, { onConflict: 'tournament_id,pool_size' });

    if (error) {
      toast.add({ severity: 'error', summary: 'Save failed', detail: error.message, life: 3000 });
      return;
    }
    toast.add({ severity: 'success', summary: 'Template saved', life: 1500 });
  } finally {
    saving.value = false;
  }
}

watch(selectedPoolSize, async (val) => {
  if (val) await loadTemplate();
});

onMounted(async () => {
  if (session.tournament && selectedPoolSize.value) {
    await loadTemplate();
  }
});
</script>

<template>
  <section class="mx-auto max-w-6xl px-4 pb-10 pt-6">
    <div class="rounded-2xl border border-slate-200 bg-white shadow-lg">
      <div class="p-5 sm:p-7">
        <div class="flex items-center justify-between gap-3">
          <div>
            <h2 class="text-2xl font-semibold text-slate-900">Schedule Templates</h2>
            <p class="mt-1 text-slate-600">
              Define round-by-round templates per pool size. Use JSON arrays for matchups and assignments.
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

        <div class="mt-6 grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div class="sm:col-span-1">
            <label class="block text-sm font-medium text-slate-700 mb-2">Pool Size</label>
            <Dropdown
              v-model="selectedPoolSize"
              :options="poolSizeOptions"
              optionLabel="label"
              optionValue="value"
              placeholder="Select pool size"
              class="w-full !rounded-xl"
              :pt="{ input: { class: '!py-3 !px-4 !text-base !rounded-xl' } }"
            />
          </div>

          <div class="sm:col-span-2">
            <div class="rounded-xl bg-gbv-bg p-4">
              <p class="text-sm text-slate-700">
                JSON fields:
              </p>
              <ul class="mt-1 text-sm text-slate-700 list-disc list-inside">
                <li><span class="font-semibold">play</span>: array of [seedA, seedB], e.g. [[1,2],[3,4]]</li>
                <li><span class="font-semibold">ref</span>: array of seed refs, e.g. [3,4]</li>
                <li><span class="font-semibold">sit</span>: array of seeds sitting out, e.g. [5]</li>
              </ul>
            </div>
          </div>
        </div>

        <div class="mt-6">
          <DataTable
            :value="templateRows"
            size="large"
            class="rounded-xl overflow-hidden"
            tableClass="!text-base"
          >
            <Column field="round" header="Round" style="width: 7rem">
              <template #body="{ data }">
                <div class="flex items-center gap-2">
                  <Button icon="pi pi-arrow-up" text rounded @click="moveRound(data.round, -1)" />
                  <Button icon="pi pi-arrow-down" text rounded @click="moveRound(data.round, 1)" />
                  <span class="font-semibold">{{ data.round }}</span>
                </div>
              </template>
            </Column>

            <Column field="play" header="Play (matchups)">
              <template #body="{ data, index }">
                <Textarea
                  v-model="templateRows[index].play"
                  autoResize
                  rows="2"
                  class="w-full !rounded-xl"
                  :invalid="!!rowErrors[index].play"
                />
                <div v-if="rowErrors[index].play" class="mt-1 text-xs text-red-600">
                  {{ rowErrors[index].play }}
                </div>
              </template>
            </Column>

            <Column field="ref" header="Ref (seeds)" style="width: 16rem">
              <template #body="{ data, index }">
                <InputText
                  v-model="templateRows[index].ref"
                  class="w-full !rounded-xl"
                  :invalid="!!rowErrors[index].ref"
                />
                <div v-if="rowErrors[index].ref" class="mt-1 text-xs text-red-600">
                  {{ rowErrors[index].ref }}
                </div>
              </template>
            </Column>

            <Column field="sit" header="Sit (seeds)" style="width: 16rem">
              <template #body="{ data, index }">
                <InputText
                  v-model="templateRows[index].sit"
                  class="w-full !rounded-xl"
                  :invalid="!!rowErrors[index].sit"
                />
                <div v-if="rowErrors[index].sit" class="mt-1 text-xs text-red-600">
                  {{ rowErrors[index].sit }}
                </div>
              </template>
            </Column>

            <Column header="">
              <template #body="{ data }">
                <div class="flex justify-end">
                  <Button icon="pi pi-trash" severity="danger" text rounded @click="removeRound(data.round)" />
                </div>
              </template>
            </Column>
          </DataTable>

          <div class="mt-4 flex items-center gap-3">
            <Button
              label="Add Round"
              icon="pi pi-plus"
              class="!rounded-xl border-none text-white gbv-grad-blue"
              @click="addRound"
            />
            <div class="flex-1"></div>
            <Button
              :disabled="!selectedPoolSize || !session.tournament"
              :loading="saving"
              label="Save Template"
              icon="pi pi-save"
              class="!rounded-xl border-none text-white gbv-grad-blue"
              @click="saveTemplate"
            />
          </div>
        </div>
      </div>
    </div>
  </section>
</template>