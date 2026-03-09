<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router';
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useToast } from 'primevue/usetoast';
import { useSessionStore, type TournamentSummary } from '../../stores/session';

withDefaults(defineProps<{ stickyHeader?: boolean }>(), {
  stickyHeader: true,
});

const router = useRouter();
const route = useRoute();
const session = useSessionStore();
const toast = useToast();

const accessCode = computed(() => (route.params.accessCode as string) ?? session.accessCode ?? '');
const hasCode = computed(() => !!accessCode.value);
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

const menuOpen = ref(false);
const menuButtonEl = ref<HTMLButtonElement | null>(null);
const menuPanelEl = ref<HTMLDivElement | null>(null);

const sameDayLoading = ref(false);
const sameDayTournaments = ref<TournamentSummary[] | null>(null);
const sameDayLoadedForDate = ref<string | null>(null);

const changeCodeOpen = ref(false);
const changeCodeValue = ref('');
const changeCodeInputEl = ref<HTMLInputElement | null>(null);
const changeCodeLoading = ref(false);

const sameDayDate = computed(() => session.tournament?.date ?? null);
const sameDayLabel = computed(() => {
  const d = sameDayDate.value;
  if (!d) return '';
  const dt = new Date(`${d}T00:00:00`);
  return dt.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
});

function statusLabel(st: string | undefined) {
  const map: Record<string, string> = {
    draft: 'Draft',
    setup: 'Setup',
    pool_play: 'Pool Play',
    bracket: 'Bracket',
    completed: 'Completed',
  };
  return (st && map[st]) ? map[st] : (st ?? 'Unknown');
}

async function loadSameDayTournaments() {
  const date = sameDayDate.value;
  if (!date) return;
  if (sameDayLoadedForDate.value === date && sameDayTournaments.value) return;

  sameDayLoading.value = true;
  try {
    await session.ensureAnon();
    sameDayTournaments.value = await session.listTournamentsByDate(date);
    sameDayLoadedForDate.value = date;
  } finally {
    sameDayLoading.value = false;
  }
}

function hardNavigateToTournamentPublic(code: string) {
  const trimmed = code.trim();
  if (!trimmed) return;

  const target = { name: 'tournament-public', params: { accessCode: trimmed } as Record<string, any> };
  router.replace(target).catch(() => { /* ignore */ });

  const resolved = router.resolve(target);
  if (typeof window !== 'undefined') {
    window.location.assign(resolved.href);
  }
}

function hardNavigateToLanding() {
  const target = { name: 'tournament-public' };
  router.replace(target).catch(() => { /* ignore */ });

  const resolved = router.resolve(target);
  if (typeof window !== 'undefined') {
    window.location.assign(resolved.href);
  }
}

async function switchTournament(code: string) {
  const trimmed = code.trim();
  if (!trimmed || trimmed === accessCode.value) {
    menuOpen.value = false;
    changeCodeOpen.value = false;
    return;
  }

  session.setAccessCode(trimmed);
  menuOpen.value = false;
  changeCodeOpen.value = false;
  hardNavigateToTournamentPublic(trimmed);
}

async function submitChangeCode() {
  const code = changeCodeValue.value.trim();
  if (!code) return;

  changeCodeLoading.value = true;
  try {
    await session.ensureAnon();
    const t = await session.loadTournamentByCode(code);
    if (!t) {
      toast.add({ severity: 'error', summary: 'Tournament does not exist', detail: '', life: 2500 });
      return;
    }
    await switchTournament(code);
  } finally {
    changeCodeLoading.value = false;
  }
}

function openChangeCode() {
  changeCodeOpen.value = true;
  changeCodeValue.value = '';
  nextTick(() => changeCodeInputEl.value?.focus());
}

function forgetCode() {
  session.clearAccessCode();
  menuOpen.value = false;
  changeCodeOpen.value = false;
  hardNavigateToLanding();
}

function closeMenu() {
  menuOpen.value = false;
  changeCodeOpen.value = false;
}

function toggleMenu() {
  menuOpen.value = !menuOpen.value;
  if (menuOpen.value) {
    loadSameDayTournaments();
    changeCodeOpen.value = false;
  }
}

function onDocPointerDown(e: PointerEvent) {
  const target = e.target as Node | null;
  if (!target) return;
  const inButton = !!menuButtonEl.value && menuButtonEl.value.contains(target);
  const inPanel = !!menuPanelEl.value && menuPanelEl.value.contains(target);
  if (!inButton && !inPanel) closeMenu();
}

function onDocKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape') closeMenu();
}

watch(menuOpen, (open) => {
  if (typeof document === 'undefined') return;
  if (open) {
    document.addEventListener('pointerdown', onDocPointerDown, true);
    document.addEventListener('keydown', onDocKeyDown);
  } else {
    document.removeEventListener('pointerdown', onDocPointerDown, true);
    document.removeEventListener('keydown', onDocKeyDown);
  }
});

watch(() => route.fullPath, () => closeMenu());
watch(() => session.tournament?.date, () => {
  sameDayLoadedForDate.value = null;
  sameDayTournaments.value = null;
});

onBeforeUnmount(() => {
  if (typeof document !== 'undefined') {
    document.removeEventListener('pointerdown', onDocPointerDown, true);
    document.removeEventListener('keydown', onDocKeyDown);
  }
});
</script>

<template>
  <div class="min-h-full min-h-dvh w-full">
    <!-- Public Header (green primary) -->
    <header
      :class="stickyHeader ? 'sticky top-0 z-50' : ''"
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
            <div v-if="hasCode" class="relative">
              <button
                ref="menuButtonEl"
                type="button"
                class="gbv-pressable rounded-2xl px-3 py-2 text-left ring-1 ring-white/20 bg-white/10 hover:bg-white/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/80 transition-colors"
                aria-label="Tournament access code menu"
                aria-haspopup="menu"
                :aria-expanded="menuOpen ? 'true' : 'false'"
                @click="toggleMenu"
              >
                <div class="flex items-center gap-2">
                  <div class="min-w-0">
                    <div class="text-[11px] leading-tight text-white/80">Code</div>
                    <div class="font-mono font-semibold leading-tight truncate">{{ accessCode }}</div>
                  </div>
                  <i
                    class="pi text-white/90"
                    :class="menuOpen ? 'pi-chevron-up' : 'pi-chevron-down'"
                    aria-hidden="true"
                  />
                </div>
              </button>

              <div
                v-if="menuOpen"
                ref="menuPanelEl"
                class="absolute right-0 mt-2 z-50 w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-2xl bg-white/95 text-slate-900 shadow-xl ring-1 ring-black/10 backdrop-blur-md"
                role="menu"
              >
                <div class="px-4 py-3 border-b border-slate-200/70">
                  <div class="text-xs text-slate-500">Signed in</div>
                  <div class="mt-0.5 font-semibold leading-tight truncate">
                    {{ tournamentName }}
                  </div>
                  <div v-if="sameDayLabel" class="mt-0.5 text-xs text-slate-500">
                    Tournaments on {{ sameDayLabel }}
                  </div>
                </div>

                <div class="p-2 max-h-[75vh] flex flex-col gap-2">
                  <div class="flex-1 overflow-hidden">
                    <div v-if="!sameDayDate" class="px-2 py-2 text-sm text-slate-600">
                      Loading tournament…
                    </div>
                    <div v-else-if="sameDayLoading" class="px-2 py-2 text-sm text-slate-600">
                      Loading tournaments…
                    </div>
                    <div v-else class="h-full overflow-auto pr-1">
                      <div class="px-2 pb-2 text-xs text-slate-500">
                        Tap a tournament to switch.
                      </div>

                      <div v-if="(sameDayTournaments ?? []).length === 0" class="px-2 py-2 text-sm text-slate-600">
                        No other tournaments found for this day.
                      </div>

                      <button
                        v-for="t in (sameDayTournaments ?? [])"
                        :key="t.id"
                        type="button"
                        class="w-full rounded-xl px-3 py-2 text-left hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-gbv-dark-green/30 transition-colors"
                        @click="switchTournament(t.access_code)"
                      >
                        <div class="flex items-center gap-2">
                          <div class="min-w-0 flex-1">
                            <div class="flex items-center gap-2">
                              <div class="font-semibold truncate">
                                {{ t.name }}
                              </div>
                              <span class="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-700">
                                {{ statusLabel(t.status) }}
                              </span>
                            </div>
                            <div class="mt-0.5 text-[11px] text-slate-500">
                              Code: <span class="font-mono">{{ t.access_code }}</span>
                            </div>
                          </div>
                          <i
                            v-if="t.access_code === accessCode"
                            class="pi pi-check text-gbv-dark-green"
                            aria-hidden="true"
                          />
                        </div>
                      </button>
                    </div>
                  </div>

                  <div class="border-t border-slate-200/70 pt-2">
                    <button
                      v-if="!changeCodeOpen"
                      type="button"
                      class="w-full rounded-xl px-3 py-2 text-left text-sm font-semibold text-slate-800 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-gbv-dark-green/30 transition-colors"
                      @click="openChangeCode"
                    >
                      <span class="flex items-center gap-2">
                        <i class="pi pi-key" aria-hidden="true" />
                        Change code…
                      </span>
                    </button>

                    <form v-else class="px-1" @submit.prevent="submitChangeCode">
                      <label class="block text-xs font-semibold text-slate-600">
                        Enter another code
                      </label>
                      <div class="mt-2 flex gap-2">
                        <input
                          ref="changeCodeInputEl"
                          v-model="changeCodeValue"
                          inputmode="text"
                          autocomplete="off"
                          placeholder="e.g. GOGATORS"
                          class="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-mono text-slate-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-gbv-dark-green/30"
                          :disabled="changeCodeLoading"
                        />
                        <button
                          type="submit"
                          class="shrink-0 rounded-xl px-3 py-2 text-sm font-semibold text-white gbv-grad-dark-green shadow-sm disabled:opacity-60"
                          :disabled="changeCodeLoading || !changeCodeValue.trim()"
                        >
                          {{ changeCodeLoading ? '…' : 'Go' }}
                        </button>
                      </div>
                      <div class="mt-2 flex items-center justify-between">
                        <button
                          type="button"
                          class="text-xs font-semibold text-slate-600 hover:text-slate-900 underline underline-offset-2"
                          @click="changeCodeOpen = false"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          class="text-xs font-semibold text-slate-600 hover:text-slate-900 underline underline-offset-2"
                          @click="forgetCode"
                        >
                          Forget code
                        </button>
                      </div>
                    </form>
                  </div>
                </div>
              </div>
            </div>
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
