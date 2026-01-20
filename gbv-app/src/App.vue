<script setup lang="ts">
import Toast from 'primevue/toast';
import { watchEffect } from 'vue';
import { useRoute } from 'vue-router';

const route = useRoute();

watchEffect(() => {
  if (typeof document === 'undefined') return;
  const body = document.body;
  const html = document.documentElement;

  const managed = ['bg-gbv-bg', 'bg-white', 'bg-gbv-blue', 'gbv-grad-green', 'text-white', 'text-slate-800'];
  for (const c of managed) {
    body.classList.remove(c);
    html.classList.remove(c);
  }

  const isAdmin = !!route.meta.blueLayout;
  const pageClasses = isAdmin ? ['bg-gbv-blue', 'text-white'] : ['gbv-grad-green', 'text-white'];
  for (const c of pageClasses) {
    body.classList.add(c);
    html.classList.add(c);
  }

  const themeColor = isAdmin ? '#2d51a6' : '#1b6a08';
  let meta = document.querySelector('meta[name="theme-color"]') as HTMLMetaElement | null;
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.appendChild(meta);
  }
  meta.content = themeColor;
});
</script>

<template>
  <div
    class="min-h-full min-h-dvh flex flex-col"
    :class="[
      $route.meta.blueLayout ? 'bg-gbv-blue text-white' : 'gbv-grad-green text-white'
    ]"
  >
    <Toast />

    <header
      v-if="!$route.meta.fullScreen"
      :class="$route.meta.blueLayout ? 'bg-transparent text-white border-b border-white/15' : 'bg-transparent text-white border-b border-white/15'"
    >
      <div class="mx-auto max-w-6xl px-4 py-4 flex items-center justify-between">
        <h1 class="text-xl sm:text-2xl font-extrabold tracking-tight">
          Gator Beach Volleyball
        </h1>
      </div>
    </header>

    <main class="flex-1" :class="{ 'mx-auto max-w-6xl w-full px-4 py-6': !$route.meta.fullScreen }">
      <router-view />
    </main>

    <footer
      v-if="!$route.meta.fullScreen"
      :class="$route.meta.blueLayout ? 'border-t border-white/15 text-sm text-white/80 bg-transparent' : 'border-t border-white/15 text-sm text-white/80 bg-transparent'"
    >
      <div class="mx-auto max-w-6xl px-4 py-4">
        © 2025 Gator Beach Volleyball
      </div>
    </footer>
  </div>
</template>
