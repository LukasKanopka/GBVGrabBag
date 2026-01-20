import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Avoid hard-crashing the SPA at module-eval time when env vars are missing (e.g., misconfigured deploy).
// Calls will still fail, but pages can render and show a user-friendly error/toast.
export const isSupabaseConfigured = !!url && !!anonKey;
const safeUrl = url || 'https://example.invalid';
const safeAnonKey = anonKey || 'missing-anon-key';

export const supabase: SupabaseClient = createClient(safeUrl, safeAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
  },
});

// Ensure Realtime has the current JWT when a user is authenticated.
// Important: avoid setting an empty token, which can cause flaky WS auth/connection behavior.
let lastRealtimeToken: string | null = null;
function syncRealtimeAuth(token: string | null) {
  if (token && token.length > 0) {
    if (token !== lastRealtimeToken) supabase.realtime.setAuth(token);
    lastRealtimeToken = token;
    return;
  }
  // Only clear if we previously set a token (e.g. user signed out).
  if (lastRealtimeToken) {
    supabase.realtime.setAuth('');
    lastRealtimeToken = null;
  }
}
supabase.auth.getSession().then(({ data }) => syncRealtimeAuth(data.session?.access_token ?? null));
supabase.auth.onAuthStateChange((_event, session) => syncRealtimeAuth(session?.access_token ?? null));

export default supabase;
