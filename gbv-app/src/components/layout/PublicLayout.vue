<script setup lang="ts">
import { useRouter } from 'vue-router';
import { computed } from 'vue';
import { useSessionStore } from '../../stores/session';

const router = useRouter();
const session = useSessionStore();

const hasCode = computed(() => !!session.accessCode);
const tournamentName = computed(() => session.tournament?.name || 'Gator Beach Volleyball');
const tournamentPhase = computed(() => {
  const st = session.tournament?.status;
  if (!st) return null;
  const map: Record<string, string> = {
    draft: 'Draft',
    setup: 'Setup',
    pool_play: 'Pool Play',
    bracket: 'Bracket',
    completed: 'Completed',
  };
  return map[st] ?? st;
});

async function changeCode() {
  session.clearAccessCode();
  router.replace({ name: 'tournament-public' });
}
</script>

<template>
  <div class="min-h-dvh w-full">
    <!-- Sticky Public Header (green primary) -->
    <header
      class="sticky top-0 z-50"
      aria-label="Public tournament header"
    >
      <div class="gbv-grad-green text-white shadow-md">
        <div class="mx-auto max-w-6xl px-4 py-3 flex items-center justify-between gap-3">
          <div class="flex items-center gap-3 min-w-0">
            <img
              src="@/assets/GBVLogo.png"
              alt="GBV"
              class="h-8 w-auto drop-shadow-md"
            />
            <div class="min-w-0">
              <div class="text-white font-extrabold tracking-tight truncate">
                {{ tournamentName }}
              </div>
              <div v-if="tournamentPhase" class="text-[11px] text-white/85">
                {{ tournamentPhase }}
              </div>
            </div>
          </div>

          <div class="flex items-center gap-2">
            <div
              v-if="hasCode"
              class="hidden sm:flex items-center rounded-full bg-white/15 text-white/90 px-3 py-1 text-xs tracking-wide"
              aria-label="Access code"
            >
              Code: <span class="ml-1 font-semibold">{{ session.accessCode }}</span>
            </div>
            <button
              v-if="hasCode"
              type="button"
              class="rounded-xl px-3 py-2 text-sm font-medium text-white hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70 transition-colors"
              @click="changeCode"
            >
              Change code
            </button>
          </div>
        </div>
      </div>
    </header>

    <!-- Page body -->
    <main class="mx-auto w-full max-w-3xl px-4 pb-10 pt-4">
      <slot />
    </main>
  </div>
</template>

<style scoped>
/* Subtle tap feedback for nested interactive elements */
:deep(a), :deep(button), :deep(.pressable) {
  transition: transform 120ms ease, box-shadow 120ms ease, background-color 120ms ease, color 120ms ease, opacity 120ms ease;
}
:deep(a:active), :deep(button:active), :deep(.pressable:active) {
  transform: translateY(0.5px) scale(0.997);
}
</style>