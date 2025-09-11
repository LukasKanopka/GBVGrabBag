<script setup lang="ts">
import Toast from 'primevue/toast';
</script>

<template>
  <div class="min-h-dvh flex flex-col">
    <Toast />

    <header class="bg-gbv-blue text-white">
      <div class="mx-auto max-w-6xl px-4 py-4 flex items-center justify-between">
        <h1 class="text-xl sm:text-2xl font-extrabold tracking-tight">
          Gator Beach Volleyball
        </h1>
      </div>
    </header>

    <main class="flex-1 mx-auto max-w-6xl w-full px-4 py-6">
      <router-view />
    </main>

    <footer class="border-t border-slate-200 text-sm text-slate-600 bg-white">
      <div class="mx-auto max-w-6xl px-4 py-4">
        © 2025 Gator Beach Volleyball
      </div>
    </footer>
  </div>
</template>
