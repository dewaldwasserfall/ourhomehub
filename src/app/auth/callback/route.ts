/**
 * Google OAuth callback.
 *
 * 1. Exchanges the one-time code for a Supabase session (sets cookies).
 * 2. Rejects accounts that are not on the allowlist (signs them out again).
 * 3. Sends new people to onboarding and members straight to their lists.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get("code");
  const supabase = await getSupabaseServerClient();

  // Step 1: no code means the user cancelled or Google returned an error.
  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=auth_failed`);
  }

  // Step 2: finish the sign-in.
  const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
  if (exchangeError) {
    return NextResponse.redirect(`${origin}/login?error=auth_failed`);
  }

  // Step 3: enforce the allowlist (the database is the source of truth).
  const { data: allowed } = await supabase.rpc("is_email_allowed");
  if (!allowed) {
    await supabase.auth.signOut();
    return NextResponse.redirect(`${origin}/login?error=not_allowed`);
  }

  // Step 4: route by household membership.
  const { data: householdId } = await supabase.rpc("current_household_id");
  return NextResponse.redirect(`${origin}${householdId ? "/" : "/onboarding"}`);
}
