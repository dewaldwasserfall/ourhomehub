/**
 * Supabase client with the service-role key: bypasses Row Level Security.
 *
 * SERVER ONLY. Used by calendar routes for writes the browser may never make
 * (synced events, the Vault-stored refresh token). Never import this from a
 * client component: the key would end up in the browser bundle.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let adminClient: SupabaseClient | undefined;

export function getSupabaseAdminClient(): SupabaseClient {
  if (typeof window !== "undefined") throw new Error("The admin client must never run in the browser");
  if (!adminClient) {
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY must be set");
    adminClient = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return adminClient;
}
