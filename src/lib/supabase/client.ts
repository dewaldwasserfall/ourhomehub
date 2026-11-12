/**
 * Supabase client for the browser.
 *
 * Used by client components for reads, writes, RPCs and realtime. The session
 * lives in cookies (managed by @supabase/ssr), so the server and the browser
 * always agree on who is signed in.
 */
"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

// Step 1: one shared instance per tab, so realtime channels are not duplicated.
let browserClient: SupabaseClient | undefined;

export function getSupabaseBrowserClient(): SupabaseClient {
  if (!browserClient) {
    browserClient = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    );
  }
  return browserClient;
}
