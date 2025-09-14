<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useSessionStore } from '../stores/session';
import InputText from 'primevue/inputtext';
import Button from 'primevue/button';
import { useToast } from 'primevue/usetoast';
import PublicLayout from '../components/layout/PublicLayout.vue';


const toast = useToast();
const route = useRoute();
const router = useRouter();
const session = useSessionStore();

const accessCodeParam = ref<string>((route.params.accessCode as string) ?? '');
const accessCodeInput = ref<string>('');
const loading = ref(false);

function resetScrollFocus() {
  if (typeof document !== 'undefined') {
    const el = document.activeElement as HTMLElement | null;
    if (el && typeof el.blur === 'function') el.blur();
  }
  if (typeof window !== 'undefined') {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }
}

async function refreshTournament(code: string) {
  loading.value = true;
  try {
    await session.ensureAnon();
    const t = await session.loadTournamentByCode(code);
    if (!t) {
      session.clearAccessCode();
      toast.add({ severity: 'error', summary: 'Tournament does not exist', detail: '', life: 3000 });
      router.replace({ name: 'tournament-public' });
      return;
    }

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
      resetScrollFocus();
      await router.replace({ name: 'tournament-public', params: { accessCode: effectiveCode } });
    }
    await refreshTournament(effectiveCode);
  }
});

async function saveCode() {
  if (!accessCodeInput.value.trim()) return;
  const code = accessCodeInput.value.trim();
  resetScrollFocus();
  loading.value = true;
  try {
    await session.ensureAnon();
    const t = await session.loadTournamentByCode(code);
    if (!t) {
      toast.add({ severity: 'error', summary: 'Tournament does not exist', life: 3000 });
      return;
    }
    session.setAccessCode(code);
    toast.add({ severity: 'success', summary: 'Code Saved', detail: code, life: 2000 });
    if (t.status === 'pool_play') {
      await router.replace({ name: 'public-pool-list', params: { accessCode: code } });
    } else if (t.status === 'bracket') {
      await router.replace({ name: 'public-bracket', params: { accessCode: code } });
    } else {
      await router.replace({ name: 'tournament-public', params: { accessCode: code } });
    }
  } finally {
    loading.value = false;
  }
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
              class="w-full !rounded-2xl !px-5 !py-4 !text-xl !bg-white/95 !shadow-lg text-gray-900"
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
          <div class="mt-3 text-center text-sm text-white/90">
            Admin? Go to
            <router-link class="underline" :to="{ name: 'admin-login' }">Admin Login</router-link>
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- Main Public Redirect Controller -->
  <PublicLayout>
    <section class="p-5 sm:p-7">
      <div class="flex items-center justify-between gap-3">
        <div>
          <h2 class="text-2xl font-semibold text-white">Tournament</h2>
          <p class="mt-1 text-white/80">
            Redirecting you to Pools or Bracket based on tournament phase…
          </p>
        </div>
        <div v-if="loading" class="text-sm text-white/80">Loading…</div>
      </div>


      <div class="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <router-link
          :to="{ name: 'public-pool-list', params: { accessCode: session.accessCode } }"
          class="rounded-xl bg-white/10 ring-1 ring-white/20 p-5 text-center hover:bg-white/15 transition-colors"
        >
          <div class="text-lg font-semibold text-white">Go to Pools</div>
          <div class="mt-1 text-sm text-white/80">Standings & schedule</div>
        </router-link>

        <router-link
          :to="{ name: 'public-bracket', params: { accessCode: session.accessCode } }"
          class="rounded-xl bg-white/10 ring-1 ring-white/20 p-5 text-center hover:bg-white/15 transition-colors"
        >
          <div class="text-lg font-semibold text-white">Go to Bracket</div>
          <div class="mt-1 text-sm text-white/80">Playoff bracket</div>
        </router-link>
      </div>

      <div class="mt-6 text-center text-sm text-white/80">
        Admin? Go to
        <router-link class="underline" :to="{ name: 'admin-login' }">Admin Login</router-link>
      </div>
    </section>
  </PublicLayout>
</template>