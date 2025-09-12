<script setup lang="ts">
import { ref, computed } from 'vue';
import { useRouter } from 'vue-router';
import { useToast } from 'primevue/usetoast';
import InputText from 'primevue/inputtext';
import Button from 'primevue/button';
import Card from 'primevue/card';
import Tag from 'primevue/tag';
import supabase from '../lib/supabase';
import { useSessionStore } from '../stores/session';
import { checkPrerequisites, generateSchedule, type GenerateResult } from '../lib/schedule';

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
    const res = await checkPrerequisites(session.tournament.id);
    prereqErrors.value = res.errors ?? [];
    if (res.ok) {
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
  if (prereqErrors.value.length > 0) {
    toast.add({ severity: 'warn', summary: 'Fix prerequisites first', detail: `${prereqErrors.value.length} issue(s)`, life: 2500 });
    return;
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
  <section class="mx-auto max-w-6xl px-4 pb-10 pt-6">
    <div class="rounded-2xl border border-slate-200 bg-white shadow-lg">
      <div class="p-5 sm:p-7">
        <div class="flex items-center justify-between gap-3">
          <div>
            <h2 class="text-2xl font-semibold text-slate-900">Generate Schedule</h2>
            <p class="mt-1 text-slate-600">
              Validate prerequisites and generate pool-play matches using schedule templates.
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

        <div v-if="session.tournament" class="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
          <!-- Status / actions -->
          <div class="lg:col-span-1">
            <div class="rounded-xl bg-gbv-bg p-4">
              <div class="flex items-center justify-between">
                <div class="text-sm text-slate-700">Existing pool matches</div>
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

          <!-- Prereq results -->
          <div class="lg:col-span-2">
            <div class="rounded-xl border border-slate-200 bg-white p-4">
              <div class="flex items-center justify-between">
                <h3 class="text-lg font-semibold text-slate-900">Prerequisite Results</h3>
                <Tag :value="prereqErrors.length === 0 ? 'OK' : 'Issues'" :severity="prereqErrors.length === 0 ? 'success' : 'warn'" />
              </div>
              <div class="mt-3">
                <div v-if="prereqErrors.length === 0" class="text-sm text-emerald-700">
                  All prerequisite checks passed. You can generate the schedule.
                </div>
                <ul v-else class="list-disc list-inside text-sm text-amber-800">
                  <li v-for="(e, idx) in prereqErrors" :key="idx">{{ e }}</li>
                </ul>
              </div>
            </div>

            <div v-if="lastResult" class="mt-6 rounded-xl border border-slate-200 bg-white p-4">
              <h3 class="text-lg font-semibold text-slate-900">Last Generation Result</h3>
              <p class="mt-1 text-sm text-slate-700">
                Inserted: <span class="font-semibold">{{ lastResult.inserted }}</span>
              </p>
              <div v-if="(lastResult.errors || []).length > 0" class="mt-2">
                <div class="text-sm font-medium text-amber-800">Errors:</div>
                <ul class="list-disc list-inside text-sm text-amber-800">
                  <li v-for="(e, idx) in lastResult.errors" :key="idx">{{ e }}</li>
                </ul>
              </div>
              <div v-else class="mt-2 text-sm text-emerald-700">No errors reported.</div>
            </div>
          </div>
        </div>

        <div class="mt-6 text-sm text-slate-600">
          Note: Generation uses admin-defined templates for each pool size. Ensure all seeded players have partners and templates exist for each pool size in use.
        </div>
      </div>
    </div>
  </section>
</template>