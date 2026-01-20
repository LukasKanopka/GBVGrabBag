// src/router/index.ts

import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';

const routes: RouteRecordRaw[] = [
  // Public landing (reads access code, redirects to Pools or Bracket)
  {
    path: '/:accessCode?',
    name: 'tournament-public',
    component: () => import('../pages/TournamentPublic.vue'),
    meta: { fullScreen: true, publicShell: true },
  },

  // New nested Pool Play routes
  {
    path: '/:accessCode/pools',
    name: 'public-pool-list',
    component: () => import('../pages/PublicPoolList.vue'),
    meta: { fullScreen: true, publicShell: true },
  },
  {
    path: '/:accessCode/pools/:poolId',
    name: 'public-pool-details',
    component: () => import('../pages/PublicPoolDetails.vue'),
    meta: { fullScreen: true, publicShell: true },
  },
  {
    path: '/:accessCode/matches/:matchId',
    name: 'match-actions',
    component: () => import('../pages/MatchActions.vue'),
    meta: { fullScreen: true, publicShell: true },
  },
  {
    path: '/:accessCode/matches/:matchId/live',
    name: 'match-live',
    component: () => import('../pages/LiveScoreboardMatch.vue'),
    meta: { fullScreen: true, publicShell: true },
  },
  {
    path: '/:accessCode/matches/:matchId/score',
    name: 'match-score',
    component: () => import('../pages/ScoreEntryMatch.vue'),
    meta: { fullScreen: true, publicShell: true },
  },

  // Bracket landing (placeholder for now)
  {
    path: '/:accessCode/bracket',
    name: 'public-bracket',
    component: () => import('../pages/PublicBracket.vue'),
    meta: { fullScreen: true, publicShell: true },
  },

  // Global leaderboard (tournament-wide standings)
  {
    path: '/:accessCode/leaderboard',
    name: 'public-leaderboard',
    component: () => import('../pages/PublicLeaderboard.vue'),
    meta: { fullScreen: true, publicShell: true },
  },

  // Legacy public pages (kept for compatibility; may be removed later)
  {
    path: '/:accessCode/score',
    name: 'score-entry',
    component: () => import('../pages/ScoreEntry.vue'),
    meta: { fullScreen: true, publicShell: true },
  },
  {
    path: '/:accessCode/live',
    name: 'live-scoreboard',
    component: () => import('../pages/LiveScoreboard.vue'),
    meta: { fullScreen: true, publicShell: true },
  },

  // Admin routes
  {
    path: '/admin/login',
    name: 'admin-login',
    component: () => import('../pages/AdminLogin.vue'),
    meta: { blueLayout: true },
  },
  {
    path: '/admin',
    name: 'admin-dashboard',
    component: () => import('../pages/AdminDashboard.vue'),
    meta: { requiresAdmin: true, blueLayout: true },
  },
  {
    path: '/admin/schedule-templates',
    name: 'admin-schedule-templates',
    component: () => import('../pages/AdminScheduleTemplates.vue'),
    meta: { requiresAdmin: true, blueLayout: true },
  },
  {
    path: '/admin/tournament-setup',
    name: 'admin-tournament-setup',
    component: () => import('../pages/AdminTournamentSetup.vue'),
    meta: { requiresAdmin: true, blueLayout: true },
  },
  {
    path: '/admin/players-import',
    name: 'admin-players-import',
    component: () => import('../pages/AdminPlayersImport.vue'),
    meta: { requiresAdmin: true, blueLayout: true },
  },
  {
    path: '/admin/pools-seeds',
    name: 'admin-pools-seeds',
    component: () => import('../pages/AdminPoolsSeeds.vue'),
    meta: { requiresAdmin: true, blueLayout: true },
  },
  {
    path: '/admin/generate-schedule',
    name: 'admin-generate-schedule',
    component: () => import('../pages/AdminGenerateSchedule.vue'),
    meta: { requiresAdmin: true, blueLayout: true },
  },
  {
    path: '/admin/bracket',
    name: 'admin-bracket',
    component: () => import('../pages/AdminBracket.vue'),
    meta: { requiresAdmin: true, blueLayout: true },
  },

  // Fallback
  {
    path: '/:pathMatch(.*)*',
    redirect: { name: 'tournament-public' },
  },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
  // Ensure page scroll resets to top on navigation (fixes "must scroll to see next page" after access code login)
  scrollBehavior(_to, _from, savedPosition) {
    if (savedPosition) return savedPosition;
    return { left: 0, top: 0 };
  },
});

// Admin auth guard (gracefully handles missing env/Supabase errors)
router.beforeEach(async (to) => {
  if (to.meta?.requiresAdmin) {
    try {
      const { useSessionStore } = await import('../stores/session');
      const store = useSessionStore();
      await store.refreshAdminUser();
      if (!store.isAdminAuthenticated) {
        return { name: 'admin-login' };
      }
    } catch (err) {
      // If Supabase env is missing or any error occurs, redirect to login instead of crashing
      console.error('Admin guard error:', err);
      return { name: 'admin-login' };
    }
  }
  return true;
});

export default router;
