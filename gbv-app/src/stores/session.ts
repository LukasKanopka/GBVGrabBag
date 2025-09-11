import { defineStore } from 'pinia';
import type { User } from '@supabase/supabase-js';
import type { Tournament } from '../types/db';

type SessionState = {
  adminUser: User | null;
  accessCode: string | null;
  initialized: boolean;
  tournament: Tournament | null;
};

const ACCESS_CODE_KEY = 'gbv.access_code';

export const useSessionStore = defineStore('session', {
  state: (): SessionState => ({
    adminUser: null,
    accessCode: null,
    initialized: false,
    tournament: null,
  }),

  getters: {
    isAdminAuthenticated: (s) => !!s.adminUser,
    hasAccessCode: (s) => !!s.accessCode,
  },

  actions: {
    initFromStorage() {
      if (this.initialized) return;
      const code = typeof localStorage !== 'undefined' ? localStorage.getItem(ACCESS_CODE_KEY) : null;
      this.accessCode = code;
      this.initialized = true;
    },

    setAccessCode(code: string) {
      this.accessCode = code.trim();
      try {
        localStorage.setItem(ACCESS_CODE_KEY, this.accessCode);
      } catch {
        // Non-critical in SSR or restricted storage environments
      }
    },

    clearAccessCode() {
      this.accessCode = null;
      this.tournament = null;
      try {
        localStorage.removeItem(ACCESS_CODE_KEY);
      } catch {
        // ignore
      }
    },

    async ensureAnon() {
      const { default: supabase } = await import('../lib/supabase');
      const { data: sess } = await supabase.auth.getSession();
      if (!sess.session) {
        // Attempt anonymous session so RLS policies with "authenticated" apply
        // If not enabled on your project, switch policies to allow anon or implement email magic link.
        try {
          // @ts-ignore - available in recent supabase-js
          await supabase.auth.signInAnonymously();
        } catch {
          // Fallback: no-op; reads still work with anon role
        }
      }
    },

    async loadTournamentByCode(code: string) {
      const { default: supabase } = await import('../lib/supabase');
      const { data, error } = await supabase
        .from('tournaments')
        .select('*')
        .eq('access_code', code)
        .single();

      if (error || !data) {
        this.tournament = null;
        return null;
      }
      this.tournament = data as Tournament;
      return this.tournament;
    },

    async refreshAdminUser() {
      const { default: supabase } = await import('../lib/supabase');
      const { data } = await supabase.auth.getUser();
      this.adminUser = data.user ?? null;
      return this.adminUser;
    },

    async signInAdminWithEmail(email: string, password: string) {
      const { default: supabase } = await import('../lib/supabase');
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      this.adminUser = data.user;
      return data.user;
    },

    async signOutAdmin() {
      const { default: supabase } = await import('../lib/supabase');
      await supabase.auth.signOut();
      this.adminUser = null;
    },
  },
});