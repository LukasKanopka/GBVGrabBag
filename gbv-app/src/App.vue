<script setup lang="ts">
import Toast from 'primevue/toast';
</script>

<template>
  <div
    class="min-h-full min-h-dvh flex flex-col"
    :class="[
      $route.meta.fullScreen
        ? ($route.meta.publicShell ? 'gbv-grad-green text-white' : 'gbv-grad-green')
        : ($route.meta.blueLayout ? 'bg-gbv-blue text-white' : 'bg-white text-slate-800')
    ]"
  >
    <Toast />

    <header
      v-if="!$route.meta.fullScreen"
      :class="$route.meta.blueLayout ? 'bg-transparent text-white border-b border-white/15' : 'bg-gbv-blue text-white'"
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
      :class="$route.meta.blueLayout ? 'border-t border-white/15 text-sm text-white/80 bg-transparent' : 'border-t border-slate-200 text-sm text-slate-600 bg-white'"
    >
      <div class="mx-auto max-w-6xl px-4 py-4">
        © 2025 Gator Beach Volleyball
      </div>
    </footer>
  </div>
</template>
