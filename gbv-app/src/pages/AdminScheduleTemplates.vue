<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useSessionStore } from '../stores/session';
import supabase from '../lib/supabase';
import Button from 'primevue/button';
import Dropdown from 'primevue/dropdown';
import { useToast } from 'primevue/usetoast';

type Matchup = { a: number | null; b: number | null };
type RoundRow = {
  round: number;
  plays: Matchup[];     // array of matchups [a vs b]
  refs: (number | null)[]; // array of referee seeds
  sits: (number | null)[]; // array of sitting seeds
};

const toast = useToast();
const router = useRouter();
const session = useSessionStore();

const accessCode = ref<string>(session.accessCode ?? '');
const selectedPoolSize = ref<number | null>(null);

// Limit pool sizes to 3–5 per requirements
const poolSizeOptions = [3, 4, 5].map((n) => ({ label: `${n} teams`, value: n }));

const rounds = ref<RoundRow[]>([]);

const loading = ref(false);
const saving = ref(false);

const seedOptions = computed(() => {
  const size = selectedPoolSize.value ?? 0;
  return Array.from({ length: size }, (_, i) => {
    const v = i + 1;
    return { label: `${v}`, value: v };
  });
});

function addRound() {
  const last = rounds.value.length ? rounds.value[rounds.value.length - 1] : null;
  const nextRound = ((last && last.round) ? last.round : 0) + 1;
  rounds.value.push({ round: nextRound, plays: [], refs: [], sits: [] });
}

function removeRound(roundNo: number) {
  rounds.value = rounds.value.filter((r) => r.round !== roundNo).map((r, idx) => ({ ...r, round: idx + 1 }));
}

function moveRound(roundNo: number, dir: -1 | 1) {
  const idx = rounds.value.findIndex((r) => r.round === roundNo);
  if (idx < 0) return;
  const newIdx = idx + dir;
  if (newIdx < 0 || newIdx >= rounds.value.length) return;
  const tmp = rounds.value[idx];
  rounds.value[idx] = rounds.value[newIdx];
  rounds.value[newIdx] = tmp;
  // Renumber
  rounds.value = rounds.value.map((r, i) => ({ ...r, round: i + 1 }));
}

function addMatchup(roundNo: number) {
  const r = rounds.value.find((x) => x.round === roundNo);
  if (!r) return;
  r.plays.push({ a: null, b: null });
}

function removeMatchup(roundNo: number, idx: number) {
  const r = rounds.value.find((x) => x.round === roundNo);
  if (!r) return;
  r.plays.splice(idx, 1);
}

function addRef(roundNo: number) {
  const r = rounds.value.find((x) => x.round === roundNo);
  if (!r) return;
  r.refs.push(null);
}

function removeRef(roundNo: number, idx: number) {
  const r = rounds.value.find((x) => x.round === roundNo);
  if (!r) return;
  r.refs.splice(idx, 1);
}

function addSit(roundNo: number) {
  const r = rounds.value.find((x) => x.round === roundNo);
  if (!r) return;
  r.sits.push(null);
}

function removeSit(roundNo: number, idx: number) {
  const r = rounds.value.find((x) => x.round === roundNo);
  if (!r) return;
  r.sits.splice(idx, 1);
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
    rounds.value = [];
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
      rounds.value = [];
      return;
    }
    if (!data || !data.template_data || !Array.isArray(data.template_data)) {
      rounds.value = [];
      return;
    }
    // Map to UI rows
    rounds.value = (data.template_data as any[]).map((r: any, i: number) => ({
      round: r.round ?? i + 1,
      plays: Array.isArray(r.play) ? r.play.map((p: any) => ({ a: Number(p[0]) || null, b: Number(p[1]) || null })) : [],
      refs: Array.isArray(r.ref) ? r.ref.map((n: any) => (Number(n) || null)) : [],
      sits: Array.isArray(r.sit) ? r.sit.map((n: any) => (Number(n) || null)) : [],
    }));
  } finally {
    loading.value = false;
  }
}

function validateRounds(): string[] {
  const issues: string[] = [];
  const size = selectedPoolSize.value ?? 0;
  rounds.value.forEach((r) => {
    r.plays.forEach((m, idx) => {
      if (m.a == null || m.b == null) {
        issues.push(`Round ${r.round}: matchup #${idx + 1} has empty seed`);
      } else {
        if (m.a < 1 || m.a > size) issues.push(`Round ${r.round}: matchup #${idx + 1} seed A out of range 1-${size}`);
        if (m.b < 1 || m.b > size) issues.push(`Round ${r.round}: matchup #${idx + 1} seed B out of range 1-${size}`);
        if (m.a === m.b) issues.push(`Round ${r.round}: matchup #${idx + 1} cannot have same seed on both sides`);
      }
    });
    r.refs.forEach((n, i) => {
      if (n != null && (n < 1 || n > size)) issues.push(`Round ${r.round}: ref #${i + 1} out of range 1-${size}`);
    });
    r.sits.forEach((n, i) => {
      if (n != null && (n < 1 || n > size)) issues.push(`Round ${r.round}: sit #${i + 1} out of range 1-${size}`);
    });
  });
  return issues;
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

  const problems = validateRounds();
  if (problems.length > 0) {
    toast.add({ severity: 'error', summary: 'Fix template issues', detail: `${problems.length} issue(s) found`, life: 3500 });
    return;
  }

  // Map UI rows to DB template_data shape
  const template = rounds.value.map((r) => ({
    round: r.round,
    play: r.plays
      .filter((m) => m.a != null && m.b != null)
      .map((m) => [m.a, m.b]),
    ref: r.refs.filter((n): n is number => n != null),
    sit: r.sits.filter((n): n is number => n != null),
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
              Define round-by-round templates per pool size using pickers. No JSON editing required.
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
                <input
                  v-model="accessCode"
                  placeholder="e.g. GATORS2025"
                  class="w-full rounded-xl border border-slate-300 px-4 py-3 text-slate-800"
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

        <!-- Pool size & helper note -->
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
            <p class="mt-2 text-xs text-slate-500">
              Supported sizes: 3–5 teams.
            </p>
          </div>

          <div class="sm:col-span-2">
            <div class="rounded-xl bg-gbv-bg p-4">
              <ul class="mt-1 text-sm text-slate-700 list-disc list-inside">
                <li>Each round can contain multiple matchups.</li>
                <li>Refs and sits are optional lists of seeds.</li>
                <li>Seeds refer to seed_in_pool numbers (1..pool size) from Pools & Seeds.</li>
              </ul>
            </div>
          </div>
        </div>

        <!-- Rounds Builder -->
        <div v-if="selectedPoolSize" class="mt-6 grid grid-cols-1 gap-4">
          <div
            v-for="r in rounds"
            :key="r.round"
            class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
          >
            <div class="flex items-center justify-between">
              <div class="font-semibold text-slate-900">Round {{ r.round }}</div>
              <div class="flex items-center gap-1">
                <Button icon="pi pi-arrow-up" text rounded @click="moveRound(r.round, -1)" />
                <Button icon="pi pi-arrow-down" text rounded @click="moveRound(r.round, 1)" />
                <Button icon="pi pi-trash" text rounded severity="danger" @click="removeRound(r.round)" />
              </div>
            </div>

            <!-- Matchups -->
            <div class="mt-3 rounded-lg bg-gbv-bg p-3">
              <div class="flex items-center justify-between">
                <div class="text-sm font-medium text-slate-800">Matchups</div>
                <Button label="Add Matchup" size="small" icon="pi pi-plus" class="!rounded-xl" @click="addMatchup(r.round)" />
              </div>
              <div class="mt-3 grid gap-2">
                <div
                  v-for="(m, idx) in r.plays"
                  :key="idx"
                  class="flex items-center gap-2"
                >
                  <Dropdown
                    v-model="m.a"
                    :options="seedOptions"
                    optionLabel="label"
                    optionValue="value"
                    placeholder="Seed A"
                    class="!rounded-xl w-36"
                    :pt="{ input: { class: '!py-2 !px-3 !text-sm !rounded-xl' } }"
                  />
                  <span class="text-slate-600">vs</span>
                  <Dropdown
                    v-model="m.b"
                    :options="seedOptions"
                    optionLabel="label"
                    optionValue="value"
                    placeholder="Seed B"
                    class="!rounded-xl w-36"
                    :pt="{ input: { class: '!py-2 !px-3 !text-sm !rounded-xl' } }"
                  />
                  <div class="flex-1"></div>
                  <Button icon="pi pi-times" rounded text severity="danger" @click="removeMatchup(r.round, idx)" />
                </div>
                <div v-if="r.plays.length === 0" class="text-xs text-slate-500">No matchups yet.</div>
              </div>
            </div>

            <!-- Refs -->
            <div class="mt-3 rounded-lg bg-gbv-bg p-3">
              <div class="flex items-center justify-between">
                <div class="text-sm font-medium text-slate-800">Refs (seeds)</div>
                <Button label="Add Ref" size="small" icon="pi pi-plus" class="!rounded-xl" @click="addRef(r.round)" />
              </div>
              <div class="mt-3 grid gap-2">
                <div
                  v-for="idx in r.refs.length"
                  :key="'ref-' + idx"
                  class="flex items-center gap-2"
                >
                  <Dropdown
                    v-model="r.refs[idx - 1]"
                    :options="seedOptions"
                    optionLabel="label"
                    optionValue="value"
                    placeholder="Seed"
                    class="!rounded-xl w-36"
                    :pt="{ input: { class: '!py-2 !px-3 !text-sm !rounded-xl' } }"
                  />
                  <Button icon="pi pi-times" rounded text severity="danger" @click="removeRef(r.round, idx - 1)" />
                </div>
                <div v-if="r.refs.length === 0" class="text-xs text-slate-500">No refs yet.</div>
              </div>
            </div>

            <!-- Sits -->
            <div class="mt-3 rounded-lg bg-gbv-bg p-3">
              <div class="flex items-center justify-between">
                <div class="text-sm font-medium text-slate-800">Sit (seeds)</div>
                <Button label="Add Sit" size="small" icon="pi pi-plus" class="!rounded-xl" @click="addSit(r.round)" />
              </div>
              <div class="mt-3 grid gap-2">
                <div
                  v-for="idx in r.sits.length"
                  :key="'sit-' + idx"
                  class="flex items-center gap-2"
                >
                  <Dropdown
                    v-model="r.sits[idx - 1]"
                    :options="seedOptions"
                    optionLabel="label"
                    optionValue="value"
                    placeholder="Seed"
                    class="!rounded-xl w-36"
                    :pt="{ input: { class: '!py-2 !px-3 !text-sm !rounded-xl' } }"
                  />
                  <Button icon="pi pi-times" rounded text severity="danger" @click="removeSit(r.round, idx - 1)" />
                </div>
                <div v-if="r.sits.length === 0" class="text-xs text-slate-500">No sits yet.</div>
              </div>
            </div>
          </div>

          <!-- Round actions -->
          <div class="flex items-center gap-3">
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

        <div v-else class="mt-6 rounded-xl border border-dashed border-slate-300 p-4 text-sm text-slate-600">
          Select a pool size to begin.
        </div>
      </div>
    </div>
  </section>
</template>