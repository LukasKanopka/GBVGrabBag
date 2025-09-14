<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useSessionStore } from '../stores/session';
import InputText from 'primevue/inputtext';
import Password from 'primevue/password';
import Button from 'primevue/button';

const router = useRouter();
const session = useSessionStore();

const email = ref('');
const password = ref('');
const loading = ref(false);
const errorMsg = ref<string | null>(null);

async function signIn(e: Event) {
  e.preventDefault();
  errorMsg.value = null;
  loading.value = true;
  try {
    await session.signInAdminWithEmail(email.value, password.value);
    router.replace({ name: 'admin-dashboard' });
  } catch (err: any) {
    errorMsg.value = err?.message ?? 'Login failed';
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <section class="min-h-dvh w-full">
    <div class="min-h-dvh w-full flex items-center justify-center px-4 py-12 gbv-blue">
      <div class="w-full max-w-xl">
        <div class="text-center">
          <h1 class="text-white text-3xl sm:text-4xl font-extrabold drop-shadow-md">
            Admin Console
          </h1>
          <p class="mt-2 text-white/90">
            Manage players, pools, schedules, and brackets.
          </p>
        </div>

        <div class="mt-8 rounded-2xl bg-white/95 p-5 sm:p-7 shadow-2xl ring-1 ring-black/5">
          <form @submit="signIn" class="space-y-5">
            <div v-if="errorMsg" class="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {{ errorMsg }}
            </div>

            <div class="space-y-2">
              <label class="text-sm font-medium text-slate-700">Email</label>
              <InputText
                v-model="email"
                type="email"
                placeholder="admin@example.com"
                class="w-full !rounded-xl !px-4 !py-3 !text-base"
                required
              />
            </div>

            <div class="space-y-2">
              <label class="text-sm font-medium text-slate-700">Password</label>
              <Password
                v-model="password"
                :feedback="false"
                toggleMask
                inputClass="!w-full !rounded-xl !px-4 !py-3 !text-base"
                placeholder="••••••••"
                required
              />
            </div>

            <Button
              type="submit"
              :disabled="loading"
              label="Sign In"
              icon="pi pi-lock-open"
              class="!w-full !rounded-xl !px-4 !py-4 !text-lg !font-semibold border-none text-white gbv-grad-blue"
            />
          </form>

          <div class="mt-6 text-center text-sm text-slate-600">
            Public site:
            <router-link class="text-gbv-blue underline" :to="{ name: 'tournament-public' }">Tournament</router-link>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>