<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useSessionStore } from '../stores/session';
import UiListItem from '@/components/ui/UiListItem.vue';
import UiSectionHeading from '@/components/ui/UiSectionHeading.vue';
import supabase from '../lib/supabase';

const router = useRouter();
const session = useSessionStore();

async function signOut() {
  await session.signOutAdmin();
  router.replace({ name: 'admin-login' });
}

const stats = ref({
  totalTeams: 0,
  teamsWithPartner: 0,
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
      // Partner logic: if full name differs from seeded name, we assume partner is set
      stats.value.teamsWithPartner = teams.filter(t => 
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
  const t = session.tournament;
  if (!t) {
    // Basic items if no tournament loaded (though usually guarded)
    return [];
  }

  // Determine Players/Partners status
  const partnersMissing = s.totalTeams - s.teamsWithPartner;
  
  // Determine Pools status
  const unpooled = s.totalTeams - s.teamsInPool;
  
  return [
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
      badge: s.totalTeams > 0 ? `${s.totalTeams} players` : undefined,
      badgeSeverity: 'info'
    },
    {
      to: { name: 'admin-pools-seeds' },
      title: 'Pools & Seeds',
      desc: 'Assign teams to pools; set seeds.',
      icon: 'pi-sort-alt',
      badge: unpooled > 0 ? `${unpooled} unassigned` : (s.totalTeams > 0 ? 'Ready' : undefined),
      badgeSeverity: unpooled > 0 ? 'warn' : 'success'
    },
    {
      to: { name: 'admin-partner-assignment' },
      title: 'Partner Assignment',
      desc: 'Enter drawn partner names for seeded players.',
      icon: 'pi-user-plus',
      badge: partnersMissing > 0 ? `${partnersMissing} missing` : (s.totalTeams > 0 ? 'Complete' : undefined),
      badgeSeverity: partnersMissing > 0 ? 'warn' : 'success'
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
      badge: s.poolMatches > 0 ? 'Generated' : 'Not Started',
      badgeSeverity: s.poolMatches > 0 ? 'success' : 'info'
    },
    {
      to: { name: 'admin-bracket' },
      title: 'Bracket',
      desc: 'Generate or manage playoff bracket.',
      icon: 'pi-sitemap',
      badge: s.bracketMatches > 0 ? 'Generated' : undefined,
      badgeSeverity: s.bracketMatches > 0 ? 'success' : undefined
    },
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
  if (session.tournament) {
    loadStats();
  }
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