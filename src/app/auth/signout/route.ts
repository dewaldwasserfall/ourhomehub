/**
 * Signs the current user out and returns them to /login.
 *
 * Exists as a route handler because server components can't clear cookies:
 * pages that need to sign someone out redirect here instead.
 * Optional ?error=<code> is passed through to the login screen.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const { origin, searchParams } = request.nextUrl;

  // Step 1: end the Supabase session (clears the auth cookies).
  const supabase = await getSupabaseServerClient();
  await supabase.auth.signOut();

  // Step 2: back to the login screen, keeping any error code.
  const error = searchParams.get("error");
  return NextResponse.redirect(`${origin}/login${error ? `?error=${encodeURIComponent(error)}` : ""}`);
}
