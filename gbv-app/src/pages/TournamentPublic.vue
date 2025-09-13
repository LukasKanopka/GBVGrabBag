<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useSessionStore } from '../stores/session';
import InputText from 'primevue/inputtext';
import Button from 'primevue/button';
import { useToast } from 'primevue/usetoast';
import supabase from '../lib/supabase';

type Pool = {
  id: string;
  tournament_id: string;
  name: string;
  court_assignment: string | null;
};

const toast = useToast();
const route = useRoute();
const router = useRouter();
const session = useSessionStore();

const accessCodeParam = ref<string>((route.params.accessCode as string) ?? '');
const accessCodeInput = ref<string>('');
const loading = ref(false);
const pools = ref<Pool[]>([]);

async function loadPools() {
  if (!session.tournament) {
    pools.value = [];
    return;
  }
  const { data, error } = await supabase
    .from('pools')
    .select('*')
    .eq('tournament_id', session.tournament.id)
    .order('name', { ascending: true });
  if (error) {
    toast.add({ severity: 'error', summary: 'Failed to load pools', detail: error.message, life: 3000 });
    pools.value = [];
    return;
  }
  pools.value = data as Pool[];
}

async function refreshTournament(code: string) {
  loading.value = true;
  try {
    await session.ensureAnon();
    const t = await session.loadTournamentByCode(code);
    if (!t) {
      toast.add({ severity: 'warn', summary: 'Not found', detail: 'Invalid tournament code', life: 2500 });
      pools.value = [];
      return;
    }
    // Load pools for potential fallback UI
    await loadPools();

    // Redirect based on tournament status to nested flow
    if (t.status === 'pool_play') {
      router.replace({ name: 'public-pool-list', params: { accessCode: code } });
    } else if (t.status === 'bracket') {
      router.replace({ name: 'public-bracket', params: { accessCode: code } });
    }
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  session.initFromStorage();

  // Canonicalize URL based on stored or param code
  if (accessCodeParam.value) {
    session.setAccessCode(accessCodeParam.value);
  }
  const effectiveCode = accessCodeParam.value || session.accessCode || '';
  if (effectiveCode) {
    if (!accessCodeParam.value) {
      router.replace({ name: 'tournament-public', params: { accessCode: effectiveCode } });
    }
    await refreshTournament(effectiveCode);
  }
});

async function saveCode() {
  if (!accessCodeInput.value.trim()) return;
  const code = accessCodeInput.value.trim();
  session.setAccessCode(code);
  toast.add({ severity: 'success', summary: 'Code Saved', detail: code, life: 2000 });
  await refreshTournament(code);
  router.push({ name: 'tournament-public', params: { accessCode: code } });
}

async function changeCode() {
  session.clearAccessCode();
  pools.value = [];
  toast.add({ severity: 'info', summary: 'Access code cleared', life: 1500 });
  router.replace({ name: 'tournament-public' });
}
</script>

<template>
  <!-- Hero Login (Access Code) -->
  <section v-if="!session.accessCode" class="min-h-dvh w-full">
    <div
      class="min-h-dvh w-full flex items-center justify-center px-4 py-12 gbv-grad-green"
    >
      <div class="w-full max-w-xl">
        <div class="text-center">
              <div class="flex flex-col items-center mb-8">
              <img 
                src="@/assets/GBVLogo.png"
                alt="GBV Logo"
                class="w-[68vw] sm:w-[60vw] md:w-[48vw] max-w-[512px] h-auto max-h-[32vh] drop-shadow-xl"
              />
              <img
                src="@/assets/GatorBeachVolleyball.png"
                alt="Gator Beach Volleyball"
                class="w-[68vw] sm:w-[60vw] md:w-[48vw] max-w-[512px] h-auto mt-4 drop-shadow-xl"
              />
              </div>
          <h1 class="text-white text-3xl sm:text-4xl font-extrabold drop-shadow-md">
            Enter the tournament code to continue.
          </h1>
        </div>

        <div class="mt-8 rounded-2xl bg-white/10 p-4 sm:p-6 backdrop-blur-md ring-1 ring-white/20">
          <label class="sr-only">Tournament Access Code</label>
          <div class="flex flex-col sm:flex-row gap-3">
            <InputText
              v-model="accessCodeInput"
              placeholder="e.g. GOGATORS"
              class="w-full !rounded-2xl !px-5 !py-4 !text-xl !bg-white/95 !shadow-lg"
            />
            <Button
              label="Continue"
              icon="pi pi-arrow-right"
              @click="saveCode"
              class="!rounded-2xl !px-6 !py-4 !text-xl !font-semibold !shadow-lg border-none text-white bg-gbv-dark-green"
              />
          </div>
          <p class="mt-3 text-white/90 text-sm">
            Access code is provided by the president.
          </p>
        </div>
      </div>
    </div>
  </section>

  <!-- Main Public Redirect Controller -->
  <section v-else class="mx-auto max-w-3xl px-4 pb-10 pt-6">
    <div class="rounded-2xl border border-slate-200 bg-white shadow-lg">
      <div class="p-5 sm:p-7">
        <div class="flex items-center justify-between gap-3">
          <div>
            <h2 class="text-2xl font-semibold text-slate-900">Tournament</h2>
            <p class="mt-1 text-slate-600">
              Redirecting you to Pools or Bracket based on tournament phase…
            </p>
          </div>
          <div v-if="loading" class="text-sm text-slate-500">Loading…</div>
        </div>
  
        <div class="mt-6 rounded-xl bg-gbv-bg p-4 text-slate-800">
          <div class="flex items-center justify-between">
            <div>
              <p class="text-sm">Access Code</p>
              <p class="font-semibold tracking-wide">{{ session.accessCode }}</p>
            </div>
            <Button
              label="Change"
              severity="secondary"
              text
              class="!text-[#faa237]"
              @click="changeCode"
            />
          </div>
        </div>
  
        <div class="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <router-link
            :to="{ name: 'public-pool-list', params: { accessCode: session.accessCode } }"
            class="rounded-xl border border-slate-200 bg-white p-5 text-center shadow-sm hover:shadow-md transition-shadow"
          >
            <div class="text-lg font-semibold">Go to Pools</div>
            <div class="mt-1 text-sm text-slate-600">Standings & schedule</div>
          </router-link>
  
          <router-link
            :to="{ name: 'public-bracket', params: { accessCode: session.accessCode } }"
            class="rounded-xl border border-slate-200 bg-white p-5 text-center shadow-sm hover:shadow-md transition-shadow"
          >
            <div class="text-lg font-semibold">Go to Bracket</div>
            <div class="mt-1 text-sm text-slate-600">Playoff bracket</div>
          </router-link>
        </div>
      </div>
    </div>
  
    <div class="mt-6 text-center text-sm text-slate-600">
      Admin? Go to
      <router-link class="text-gbv-blue underline" :to="{ name: 'admin-login' }">Admin Login</router-link>
    </div>
  </section>
</template>