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

export default supabase;
