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
    <div class="min-h-dvh w-full flex items-center justify-center px-4 py-6 bg-gbv-blue">
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
            Admin Console
          </h1>
          <p class="mt-2 text-white/90">
            Manage players, pools, schedules, and brackets.
          </p>
        </div>

        <div class="mt-8 rounded-2xl bg-white/10 p-4 sm:p-6 backdrop-blur-md ring-1 ring-white/20">
          <form @submit="signIn" class="space-y-5">
            <div v-if="errorMsg" class="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {{ errorMsg }}
            </div>

            <div class="space-y-2">
              <label class="text-sm font-semibold text-white">Email</label>
              <InputText
                v-model="email"
                type="email"
                placeholder="admin@example.com"
                class="w-full !rounded-xl !px-4 !py-3 !text-base bg-white/95 text-gray-900"
                required
              />
            </div>

            <div class="space-y-2">
              <label class="text-sm font-semibold text-white">Password</label>
              <Password
                v-model="password"
                :feedback="false"
                toggleMask
                class="w-full"
                inputClass="!rounded-xl !px-4 !py-3 !text-base bg-white/95 text-gray-900"
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

          <div class="mt-6 text-center text-sm text-white/90">
            Public site:
            <router-link class="underline hover:text-white" :to="{ name: 'tournament-public' }">Tournament</router-link>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
