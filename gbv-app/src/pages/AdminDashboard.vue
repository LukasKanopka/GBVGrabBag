<script setup lang="ts">
import { useRouter } from 'vue-router';
import { useSessionStore } from '../stores/session';
import UiListItem from '@/components/ui/UiListItem.vue';
import UiSectionHeading from '@/components/ui/UiSectionHeading.vue';

const router = useRouter();
const session = useSessionStore();

async function signOut() {
  await session.signOutAdmin();
  router.replace({ name: 'admin-login' });
}

type NavItem = {
  to: any | null;
  title: string;
  desc: string;
  icon: string;
  disabled?: boolean;
};

const navItems: NavItem[] = [
  {
    to: { name: 'admin-tournament-setup' },
    title: 'Tournament Setup',
    desc: 'Create/edit tournaments, rules, and status.',
    icon: 'pi-cog',
  },
  {
    to: { name: 'admin-players-import' },
    title: 'Players Import',
    desc: 'Upload CSV or add/remove players manually.',
    icon: 'pi-upload',
  },
  {
    to: { name: 'admin-pools-seeds' },
    title: 'Pools & Seeds',
    desc: 'Assign teams to pools; set seeds.',
    icon: 'pi-sort-alt',
  },
  {
    to: { name: 'admin-partner-assignment' },
    title: 'Partner Assignment',
    desc: 'Enter drawn partner names for seeded players.',
    icon: 'pi-user-plus',
  },
  {
    to: { name: 'admin-schedule-templates' },
    title: 'Schedule Templates',
    desc: 'Define templates for 4–5 team pools.',
    icon: 'pi-table',
  },
  {
    to: { name: 'admin-generate-schedule' },
    title: 'Generate Schedule',
    desc: 'Run prerequisites and create pool-play matches.',
    icon: 'pi-cog',
  },
  {
    to: { name: 'admin-bracket' },
    title: 'Bracket',
    desc: 'Generate or manage playoff bracket.',
    icon: 'pi-sitemap',
  },
];

const mid = Math.ceil(navItems.length / 2);
const leftItems = navItems.slice(0, mid);
const rightItems = navItems.slice(mid);
</script>

<template>
  <section class="mx-auto w-full max-w-5xl px-4 py-6">
    <UiSectionHeading
      title="Admin Dashboard"
      subtitle="Tournament setup and day-of operations."
      :divider="true"
    >
      
        <button
          class="rounded-md border border-white/30 px-3 py-1.5 text-sm hover:bg-white/10"
          @click="signOut"
        >
          Sign Out
        </button>
      
    </UiSectionHeading>

    <div class="grid grid-cols-1 lg:grid-cols-2 gap-x-8">
      <div>
        <div class="rounded-lg border border-white/15 overflow-hidden">
          <UiListItem
            v-for="it in leftItems"
            :key="it.title"
            :title="it.title"
            :description="it.desc"
            :to="it.to"
            :icon="it.icon"
            :disabled="it.disabled"
          />
        </div>
      </div>
      <div class="mt-6 lg:mt-0">
        <div class="rounded-lg border border-white/15 overflow-hidden">
          <UiListItem
            v-for="it in rightItems"
            :key="it.title"
            :title="it.title"
            :description="it.desc"
            :to="it.to"
            :icon="it.icon"
            :disabled="it.disabled"
          />
        </div>
      </div>
    </div>

    <div class="mt-6 text-sm text-white/80">
      Public site:
      <router-link class="underline" :to="{ name: 'tournament-public' }">Tournament View</router-link>
    </div>
  </section>
</template>

<style scoped>
</style>