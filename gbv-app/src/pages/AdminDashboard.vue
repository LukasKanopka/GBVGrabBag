<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useSessionStore } from '../stores/session';
import UiListItem from '@/components/ui/UiListItem.vue';
import UiSectionHeading from '@/components/ui/UiSectionHeading.vue';
import supabase from '../lib/supabase';
import InputText from 'primevue/inputtext';
import Button from 'primevue/button';
import { useToast } from 'primevue/usetoast';

const router = useRouter();
const session = useSessionStore();
const toast = useToast();

async function signOut() {
  await session.signOutAdmin();
  router.replace({ name: 'admin-login' });
}

const accessCode = ref<string>(session.accessCode ?? '');
const loadingTournament = ref(false);

async function loadTournamentByAccessCode(opts?: { silent?: boolean }) {
  const silent = !!opts?.silent;
  const code = accessCode.value?.trim() ?? '';
  if (!code) {
    if (!silent) toast.add({ severity: 'warn', summary: 'Access code required', life: 2000 });
    return;
  }

  loadingTournament.value = true;
  try {
    await session.ensureAnon();
    session.setAccessCode(code);
    const t = await session.loadTournamentByCode(code);
    if (!t) {
      if (!silent) toast.add({ severity: 'error', summary: 'Tournament not found', life: 2500 });
      return;
    }
    if (!silent) toast.add({ severity: 'success', summary: 'Tournament loaded', detail: t.name, life: 1500 });
    await loadStats();
  } catch (err: any) {
    console.error('Failed to load tournament:', err);
    if (!silent) toast.add({ severity: 'error', summary: 'Load failed', detail: err?.message ?? 'Unknown error', life: 3000 });
  } finally {
    loadingTournament.value = false;
  }
}

const stats = ref({
  totalTeams: 0,
  teamsNamed: 0,
  teamsInPool: 0,
  poolMatches: 0,
  bracketMatches: 0,
  loading: false
});

async function loadStats() {
  if (!session.tournament) return;
  stats.value.loading = true;
  try {
    const tId = session.tournament.id;

    // Teams stats
    const { data: teams, error: tErr } = await supabase
      .from('teams')
      .select('seeded_player_name, full_team_name, pool_id')
      .eq('tournament_id', tId);
    
    if (!tErr && teams) {
      stats.value.totalTeams = teams.length;
      stats.value.teamsInPool = teams.filter(t => !!t.pool_id).length;
      // If full name differs from seeded name, we assume the team has been fully named.
      stats.value.teamsNamed = teams.filter(t =>
        (t.full_team_name || '').trim() !== (t.seeded_player_name || '').trim()
      ).length;
    }

    // Pool matches
    const { count: poolCount } = await supabase
      .from('matches')
      .select('*', { count: 'exact', head: true })
      .eq('tournament_id', tId)
      .eq('match_type', 'pool');
    stats.value.poolMatches = poolCount || 0;

    // Bracket matches
    const { count: bracketCount } = await supabase
      .from('matches')
      .select('*', { count: 'exact', head: true })
      .eq('tournament_id', tId)
      .eq('match_type', 'bracket');
    stats.value.bracketMatches = bracketCount || 0;

  } catch (err: any) {
    console.error('Failed to load dashboard stats:', err);
    toast.add({ severity: 'error', summary: 'Stats failed to load', detail: err?.message ?? 'Unknown error', life: 3000 });
  } finally {
    stats.value.loading = false;
  }
}

type NavItem = {
  to: any | null;
  title: string;
  desc: string;
  icon: string;
  disabled?: boolean;
  badge?: string | number;
  badgeSeverity?: 'success' | 'warn' | 'danger' | 'info';
};

const navItems = computed<NavItem[]>(() => {
  const s = stats.value;
  const hasTournament = !!session.tournament;

  // Determine team naming status
  const namesMissing = s.totalTeams - s.teamsNamed;
  
  // Determine Pools status
  const unpooled = s.totalTeams - s.teamsInPool;

  const needsTournament = (item: Omit<NavItem, 'disabled' | 'desc'> & { desc: string }): NavItem => ({
    ...item,
    desc: hasTournament ? item.desc : 'Load a tournament access code to enable.',
    disabled: !hasTournament,
  });
  
  return [
    {
      to: { name: 'admin-tournament-setup' },
      title: 'Tournament Setup',
      desc: 'Create/edit tournaments, rules, and status.',
      icon: 'pi-cog',
    },
    needsTournament({
      to: { name: 'admin-players-import' },
      title: 'Players Import',
      desc: 'Upload CSV or add/remove teams manually.',
      icon: 'pi-upload',
      badge: hasTournament
        ? (s.totalTeams > 0 ? (namesMissing > 0 ? `${namesMissing} unnamed` : 'Ready') : undefined)
        : undefined,
      badgeSeverity: namesMissing > 0 ? 'warn' : 'success'
    }),
    needsTournament({
      to: { name: 'admin-pools-seeds' },
      title: 'Pools & Seeds',
      desc: 'Assign teams to pools; set seeds.',
      icon: 'pi-sort-alt',
      badge: hasTournament
        ? (unpooled > 0 ? `${unpooled} unassigned` : (s.totalTeams > 0 ? 'Ready' : undefined))
        : undefined,
      badgeSeverity: unpooled > 0 ? 'warn' : 'success',
    }),
    needsTournament({
      to: { name: 'admin-schedule-templates' },
      title: 'Schedule Templates',
      desc: 'Define templates for 4–5 team pools.',
      icon: 'pi-table',
    }),
    needsTournament({
      to: { name: 'admin-generate-schedule' },
      title: 'Generate Schedule',
      desc: 'Run prerequisites and create pool-play matches.',
      icon: 'pi-cog',
      badge: hasTournament ? (s.poolMatches > 0 ? 'Generated' : 'Not Started') : undefined,
      badgeSeverity: s.poolMatches > 0 ? 'success' : 'info',
    }),
    needsTournament({
      to: { name: 'admin-bracket' },
      title: 'Bracket',
      desc: 'Generate or manage playoff bracket.',
      icon: 'pi-sitemap',
      badge: hasTournament ? (s.bracketMatches > 0 ? 'Generated' : undefined) : undefined,
      badgeSeverity: s.bracketMatches > 0 ? 'success' : undefined,
    }),
  ];
});

const leftItems = computed(() => {
  const all = navItems.value;
  const mid = Math.ceil(all.length / 2);
  return all.slice(0, mid);
});

const rightItems = computed(() => {
  const all = navItems.value;
  const mid = Math.ceil(all.length / 2);
  return all.slice(mid);
});

onMounted(() => {
  session.initFromStorage();
  if (!session.tournament && session.accessCode) {
    accessCode.value = session.accessCode;
    loadTournamentByAccessCode({ silent: true });
    return;
  }
  if (session.tournament) loadStats();
});
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

    <div class="mb-6 rounded-xl border border-white/15 bg-white/5 p-4">
      <div class="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div class="flex-1 min-w-0">
          <div class="text-sm text-white/80">Tournament</div>
          <div class="mt-0.5 font-semibold truncate">
            {{ session.tournament ? session.tournament.name : 'No tournament loaded' }}
          </div>
          <div v-if="session.accessCode" class="mt-0.5 text-sm text-white/80">
            Access code: <span class="font-mono">{{ session.accessCode }}</span>
          </div>
        </div>

        <form class="flex gap-2 items-end" @submit.prevent="loadTournamentByAccessCode()">
          <div class="flex flex-col gap-1">
            <label class="text-sm font-semibold text-white">Access Code</label>
            <InputText
              v-model="accessCode"
              placeholder="e.g. FALL25"
              class="w-44 !rounded-xl !px-3 !py-2 bg-white/95 text-gray-900"
              :disabled="loadingTournament"
            />
          </div>
          <Button
            type="submit"
            label="Load"
            icon="pi pi-refresh"
            class="!rounded-xl border-none text-white gbv-grad-blue"
            :loading="loadingTournament"
          />
        </form>
      </div>
    </div>

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
            :badge="it.badge"
            :badgeSeverity="it.badgeSeverity"
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
            :badge="it.badge"
            :badgeSeverity="it.badgeSeverity"
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
