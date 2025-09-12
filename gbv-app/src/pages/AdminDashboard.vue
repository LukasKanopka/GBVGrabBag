<script setup lang="ts">
import { useRouter } from 'vue-router';
import { useSessionStore } from '../stores/session';

const router = useRouter();
const session = useSessionStore();

async function signOut() {
  await session.signOutAdmin();
  router.replace({ name: 'admin-login' });
}
</script>

<template>
  <section class="mx-auto max-w-5xl">
    <div class="rounded-lg border border-slate-200 bg-white shadow-sm">
      <div class="p-4 sm:p-6">
        <div class="flex items-center justify-between">
          <h2 class="text-xl font-semibold text-slate-800">Admin Dashboard</h2>
          <button
            class="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-50"
            @click="signOut"
          >
            Sign Out
          </button>
        </div>

        <p class="mt-1 text-slate-600">
          Tournament setup and day-of operations. Sections below are placeholders per PRD and will be implemented next.
        </p>

        <div class="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div class="rounded-md border border-slate-200 p-4">
            <h3 class="font-semibold text-slate-800">Tournament Setup</h3>
            <p class="mt-1 text-sm text-slate-600">Create/edit tournaments, rules, and status.</p>
            <router-link
              :to="{ name: 'admin-tournament-setup' }"
              class="mt-3 inline-flex items-center justify-center rounded-xl px-4 py-2 text-white font-medium shadow-md gbv-grad-blue"
            >
              Manage Tournaments
            </router-link>
          </div>

          <div class="rounded-md border border-slate-200 p-4">
            <h3 class="font-semibold text-slate-800">Players Import</h3>
            <p class="mt-1 text-sm text-slate-600">Upload CSV or add/remove players manually.</p>
            <router-link
              :to="{ name: 'admin-players-import' }"
              class="mt-3 inline-flex items-center justify-center rounded-xl px-4 py-2 text-white font-medium shadow-md gbv-grad-blue"
            >
              Open Importer
            </router-link>
          </div>

          <div class="rounded-md border border-slate-200 p-4">
            <h3 class="font-semibold text-slate-800">Pools & Seeds</h3>
            <p class="mt-1 text-sm text-slate-600">Drag players into pools and assign seeds.</p>
            <router-link
              :to="{ name: 'admin-pools-seeds' }"
              class="mt-3 inline-flex items-center justify-center rounded-xl px-4 py-2 text-white font-medium shadow-md gbv-grad-blue"
            >
              Open Pools & Seeds
            </router-link>
          </div>

          <div class="rounded-md border border-slate-200 p-4">
            <h3 class="font-semibold text-slate-800">Partner Assignment (Hat Draw)</h3>
            <p class="mt-1 text-sm text-slate-600">Tap seeded player and add drawn partner name (mobile-first).</p>
            <router-link
              :to="{ name: 'admin-partner-assignment' }"
              class="mt-3 inline-flex items-center justify-center rounded-xl px-4 py-2 text-white font-medium shadow-md gbv-grad-blue"
            >
              Open Partner Assignment
            </router-link>
          </div>

          <div class="rounded-md border border-slate-200 p-4">
            <h3 class="font-semibold text-slate-800">Schedule Templates</h3>
            <p class="mt-1 text-sm text-slate-600">Define round-by-round templates per pool size.</p>
            <router-link
              :to="{ name: 'admin-schedule-templates' }"
              class="mt-3 inline-flex items-center justify-center rounded-xl px-4 py-2 text-white font-medium shadow-md gbv-grad-blue"
            >
              Manage Templates
            </router-link>
          </div>

          <div class="rounded-md border border-slate-200 p-4">
            <h3 class="font-semibold text-slate-800">Generate Schedule</h3>
            <p class="mt-1 text-sm text-slate-600">Create pool-play matches using selected templates.</p>
            <router-link
              :to="{ name: 'admin-generate-schedule' }"
              class="mt-3 inline-flex items-center justify-center rounded-xl px-4 py-2 text-white font-medium shadow-md gbv-grad-blue"
            >
              Open Generator
            </router-link>
          </div>

          <div class="rounded-md border border-slate-200 p-4">
            <h3 class="font-semibold text-slate-800">Bracket</h3>
            <p class="mt-1 text-sm text-slate-600">Generate, rebuild, or switch to manual mode.</p>
            <div class="mt-3 rounded-md border border-dashed border-slate-300 p-4 text-center text-slate-600">
              Coming soon
            </div>
          </div>
        </div>

        <div class="mt-6 text-sm text-slate-600">
          Public site:
          <router-link class="text-gbv-blue underline" :to="{ name: 'tournament-public' }">Tournament View</router-link>
        </div>
      </div>
    </div>
  </section>
</template>