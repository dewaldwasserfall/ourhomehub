/**
 * Supabase client for server components and route handlers.
 *
 * Reads and refreshes the session from the request cookies. Server components
 * cannot set cookies, so a failed write there is ignored: the middleware
 * refreshes the session on every request instead.
 */
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export async function getSupabaseServerClient() {
  // Step 1: Next.js 15 exposes the request cookies asynchronously.
  const cookieStore = await cookies();

  // Step 2: bridge Supabase's cookie interface to Next's cookie store.
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
          } catch {
            // Called from a server component: safe to ignore, see file comment.
          }
        },
      },
    },
  );
}
