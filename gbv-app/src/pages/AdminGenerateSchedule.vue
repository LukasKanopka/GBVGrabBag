<script setup lang="ts">
import { ref, computed } from 'vue';
import { useRouter } from 'vue-router';
import { useToast } from 'primevue/usetoast';
import InputText from 'primevue/inputtext';
import Button from 'primevue/button';
import Tag from 'primevue/tag';
import supabase from '../lib/supabase';
import { useSessionStore } from '../stores/session';
import { checkPrerequisites, generateSchedule, type GenerateResult } from '../lib/schedule';
import UiSectionHeading from '@/components/ui/UiSectionHeading.vue';

const router = useRouter();
const toast = useToast();
const session = useSessionStore();

const accessCode = ref<string>(session.accessCode ?? '');

const loading = ref(false);
const checking = ref(false);
const generating = ref(false);

const prereqErrors = ref<string[]>([]);
const hasMatches = ref<boolean>(false);
const lastResult = ref<GenerateResult | null>(null);

const canGenerate = computed(() => prereqErrors.value.length === 0);

async function refreshPrereqs(): Promise<boolean> {
  if (!session.tournament) return false;
  const res = await checkPrerequisites(session.tournament.id);
  prereqErrors.value = res.errors ?? [];
  return res.ok;
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
      prereqErrors.value = [];
      hasMatches.value = false;
      return;
    }
    toast.add({ severity: 'success', summary: 'Tournament loaded', detail: t.name, life: 1500 });
    await checkExistingMatches();
    await refreshPrereqs();
  } finally {
    loading.value = false;
  }
}

async function checkExistingMatches() {
  if (!session.tournament) return;
  const { data, error } = await supabase
    .from('matches')
    .select('id', { count: 'exact', head: false })
    .eq('tournament_id', session.tournament.id)
    .eq('match_type', 'pool')
    .limit(1);
  if (error) {
    toast.add({ severity: 'error', summary: 'Failed to check existing matches', detail: error.message, life: 2500 });
    hasMatches.value = false;
    return;
  }
  hasMatches.value = Array.isArray(data) && data.length > 0;
}

async function runPrereqCheck() {
  if (!session.tournament) {
    toast.add({ severity: 'warn', summary: 'Load a tournament first', life: 1500 });
    return;
  }
  checking.value = true;
  try {
    const ok = await refreshPrereqs();
    if (ok) {
      toast.add({ severity: 'success', summary: 'All prerequisites satisfied', life: 1500 });
    } else {
      toast.add({ severity: 'warn', summary: 'Prerequisites not met', detail: `${prereqErrors.value.length} issue(s)`, life: 3000 });
    }
  } catch (err: any) {
    toast.add({ severity: 'error', summary: 'Check failed', detail: err?.message ?? 'Unknown error', life: 3000 });
  } finally {
    checking.value = false;
  }
}

async function deleteExistingPoolMatches() {
  if (!session.tournament) return;
  const ok = confirm('Delete all existing pool matches for this tournament? This cannot be undone.');
  if (!ok) return false;
  const { error } = await supabase
    .from('matches')
    .delete()
    .eq('tournament_id', session.tournament.id)
    .eq('match_type', 'pool');
  if (error) {
    toast.add({ severity: 'error', summary: 'Delete failed', detail: error.message, life: 3000 });
    return false;
  }
  toast.add({ severity: 'success', summary: 'Existing pool matches deleted', life: 1200 });
  hasMatches.value = false;
  return true;
}

async function runGenerate() {
  lastResult.value = null;
  if (!session.tournament) {
    toast.add({ severity: 'warn', summary: 'Load a tournament first', life: 1500 });
    return;
  }
  checking.value = true;
  try {
    const ok = await refreshPrereqs();
    if (!ok) {
      toast.add({ severity: 'warn', summary: 'Fix prerequisites first', detail: `${prereqErrors.value.length} issue(s)`, life: 2500 });
      return;
    }
  } finally {
    checking.value = false;
  }
  // Guard against duplicates
  if (hasMatches.value) {
    const proceeded = await deleteExistingPoolMatches();
    if (!proceeded) return;
  }

  generating.value = true;
  try {
    const res = await generateSchedule(session.tournament.id);
    lastResult.value = res;
    if ((res.errors ?? []).length === 0) {
      toast.add({ severity: 'success', summary: `Generated ${res.inserted} match(es)`, life: 2000 });
    } else {
      toast.add({ severity: 'warn', summary: `Generated ${res.inserted}, with ${res.errors.length} error(s)`, life: 3500 });
    }
    await checkExistingMatches();
  } catch (err: any) {
    toast.add({ severity: 'error', summary: 'Generation failed', detail: err?.message ?? 'Unknown error', life: 3000 });
  } finally {
    generating.value = false;
  }
}
</script>

<template>
  <section class="mx-auto max-w-6xl px-4 py-6">
    <UiSectionHeading
      title="Generate Schedule"
      subtitle="Validate prerequisites and generate pool-play matches using schedule templates."
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

    <!-- Tournament loader / context -->
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
        Loaded: <span class="font-semibold">{{ session.tournament.name }}</span>
        <span class="ml-2 text-white/80">({{ session.accessCode }})</span>
      </div>
    </div>

    <div v-if="session.tournament" class="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
      <!-- Status / actions -->
      <div class="lg:col-span-1">
        <div class="rounded-lg border border-white/15 bg-white/5 p-4">
          <div class="flex items-center justify-between">
            <div class="text-sm">Existing pool matches</div>
            <Tag :value="hasMatches ? 'Yes' : 'No'" :severity="hasMatches ? 'warn' : 'success'" />
          </div>
          <div class="mt-4 grid gap-3">
            <Button
              :loading="checking"
              label="Check Prerequisites"
              icon="pi pi-search"
              class="!rounded-xl border-none text-white gbv-grad-blue"
              @click="runPrereqCheck"
            />
            <Button
              :disabled="!canGenerate"
              :loading="generating"
              label="Generate Schedule"
              icon="pi pi-cog"
              class="!rounded-xl border-none text-white gbv-grad-green"
              @click="runGenerate"
            />
            <Button
              v-if="hasMatches"
              :loading="generating"
              label="Delete Existing Pool Matches"
              icon="pi pi-trash"
              severity="danger"
              class="!rounded-xl"
              @click="deleteExistingPoolMatches"
            />
          </div>
        </div>
      </div>

      <!-- Prereq results and last result -->
      <div class="lg:col-span-2">
        <div class="rounded-lg border border-white/15 bg-white/5 p-4">
          <div class="flex items-center justify-between">
            <h3 class="text-lg font-semibold">Prerequisite Results</h3>
            <Tag :value="prereqErrors.length === 0 ? 'OK' : 'Issues'" :severity="prereqErrors.length === 0 ? 'success' : 'warn'" />
          </div>
          <div class="mt-3">
            <div v-if="prereqErrors.length === 0" class="text-sm text-emerald-200">
              All prerequisite checks passed. You can generate the schedule.
            </div>
            <ul v-else class="list-disc list-inside text-sm text-amber-200">
              <li v-for="(e, idx) in prereqErrors" :key="idx">{{ e }}</li>
            </ul>
          </div>
        </div>

        <div v-if="lastResult" class="mt-6 rounded-lg border border-white/15 bg-white/5 p-4">
          <h3 class="text-lg font-semibold">Last Generation Result</h3>
          <p class="mt-1 text-sm">
            Inserted: <span class="font-semibold">{{ lastResult.inserted }}</span>
          </p>
          <div v-if="(lastResult.errors || []).length > 0" class="mt-2">
            <div class="text-sm font-medium text-amber-200">Errors:</div>
            <ul class="list-disc list-inside text-sm text-amber-200">
              <li v-for="(e, idx) in lastResult.errors" :key="idx">{{ e }}</li>
            </ul>
          </div>
          <div v-else class="mt-2 text-sm text-emerald-200">No errors reported.</div>
        </div>
      </div>
    </div>

    <div class="mt-6 text-sm text-white/80">
      Note: Generation uses admin-defined templates per pool size. Only pool sizes 4–5 are supported. Ensure all teams have a full team name and templates exist for each size in use.
    </div>
  </section>
</template>

<style scoped>
</style>
