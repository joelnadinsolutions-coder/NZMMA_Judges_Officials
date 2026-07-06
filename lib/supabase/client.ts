import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Single browser client for the judge PWA.
 *
 * We use plain @supabase/supabase-js (not the SSR cookie helper) on purpose:
 * this app runs as an INSTALLED, standalone PWA that must survive being
 * backgrounded and relaunched ringside. localStorage session persistence is
 * more robust in that context than cookie round-trips, and it works offline.
 */
let browserClient: SupabaseClient | undefined;

export function getSupabase(): SupabaseClient {
  if (browserClient) return browserClient;

  browserClient = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storageKey: 'nzmmaf-judge-auth',
      },
      realtime: { params: { eventsPerSecond: 5 } },
    },
  );
  return browserClient;
}
