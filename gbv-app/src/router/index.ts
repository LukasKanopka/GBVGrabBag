import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';

const routes: RouteRecordRaw[] = [
  {
    path: '/:accessCode?',
    name: 'tournament-public',
    component: () => import('../pages/TournamentPublic.vue'),
  },
  {
    path: '/:accessCode/score',
    name: 'score-entry',
    component: () => import('../pages/ScoreEntry.vue'),
  },
  {
    path: '/:accessCode/live',
    name: 'live-scoreboard',
    component: () => import('../pages/LiveScoreboard.vue'),
  },
  {
    path: '/admin/login',
    name: 'admin-login',
    component: () => import('../pages/AdminLogin.vue'),
  },
  {
    path: '/admin',
    name: 'admin-dashboard',
    component: () => import('../pages/AdminDashboard.vue'),
    meta: { requiresAdmin: true },
  },
  {
    path: '/admin/schedule-templates',
    name: 'admin-schedule-templates',
    component: () => import('../pages/AdminScheduleTemplates.vue'),
    meta: { requiresAdmin: true },
  },
  {
    path: '/:pathMatch(.*)*',
    redirect: { name: 'tournament-public' },
  },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
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