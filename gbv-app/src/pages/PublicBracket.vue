<script setup lang="ts">
import { onMounted, ref, computed } from 'vue';
import { useRoute } from 'vue-router';
import { useSessionStore } from '../stores/session';
import { useToast } from 'primevue/usetoast';

const route = useRoute();
const session = useSessionStore();
const toast = useToast();

const accessCode = computed(() => (route.params.accessCode as string) ?? session.accessCode ?? '');
const loading = ref(false);

onMounted(async () => {
  if (accessCode.value) session.setAccessCode(accessCode.value);
  loading.value = true;
  try {
    await session.ensureAnon();
    if (!session.tournament) {
      const t = await session.loadTournamentByCode(accessCode.value);
      if (!t) {
        toast.add({ severity: 'warn', summary: 'Not found', detail: 'Invalid tournament code', life: 2500 });
      }
    }
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <section class="mx-auto max-w-3xl px-4 pb-10 pt-6">
    <div class="rounded-2xl border border-slate-200 bg-white shadow-lg">
      <div class="p-5 sm:p-7">
        <div class="flex items-center justify-between gap-3">
          <div>
            <h2 class="text-2xl font-semibold text-slate-900">Bracket</h2>
            <p class="mt-1 text-slate-600">
              Bracket view placeholder. This page will render the generated playoff bracket when Tournament.status is "bracket".
            </p>
          </div>
          <div v-if="loading" class="text-sm text-slate-500">Loading…</div>
        </div>

        <div class="mt-6 rounded-xl bg-gbv-bg p-4 text-slate-800">
          <p class="text-sm">Access Code</p>
          <p class="font-semibold tracking-wide">{{ accessCode || '—' }}</p>
        </div>

        <div class="mt-6 rounded-xl border border-dashed border-slate-300 p-6 text-center text-slate-600">
          Bracket UI coming in Phase D.
        </div>
      </div>
    </div>
  </section>
</template>