/**
 * POST /api/board/pair   { code: "12345678" }
 *
 * Turns a wall tablet into the household's Family board. An adult made the
 * 8-digit code under Household → Family board; the tablet sends it here.
 *
 *   1. Check the code exists and is still valid (no account is made for a
 *      wrong code).
 *   2. Make the board's own sign-in (service role). Its email is internal and
 *      its password random; neither is ever shown or stored. If the tablet
 *      loses its session, an adult simply pairs it again.
 *   3. Use the code for that sign-in (claim_board_code makes the board row).
 *   4. Sign the tablet in: the session cookie is set on this response.
 *
 * Public route (the tablet isn't signed in yet); the code is the secret.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { jsonError } from "@/lib/calendar/caller";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  // Step 0: an 8-digit code (spaces allowed, as shown on screen).
  const body = (await request.json().catch(() => null)) as { code?: unknown } | null;
  const code = typeof body?.code === "string" ? body.code.replace(/\s+/g, "") : "";
  if (!/^[0-9]{8}$/.test(code)) return jsonError(400, "invalid_code", "Type the 8 digits shown on the grown-up's phone.");

  const admin = getSupabaseAdminClient();

  // Step 1: is the code real and unused?
  const { data: pairing } = await admin
    .from("board_pairing_codes")
    .select("code")
    .eq("code", code)
    .is("used_at", null)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (!pairing) return jsonError(400, "invalid_code", "That code didn't work. It may have expired: make a new one.");

  // Step 2: the board's own sign-in.
  const email = `board-${randomUUID()}@board.ourhomehub.nl`;
  const password = randomBytes(32).toString("base64url");
  const { data: created, error: createError } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (createError || !created.user) {
    console.error("[board/pair] createUser", createError?.message);
    return jsonError(500, "pair_failed", "Couldn't set up the board. Try again.");
  }

  // Step 3: claim the code (makes the boards row). Undo the sign-in if not.
  const { error: claimError } = await admin.rpc("claim_board_code", { p_code: code, p_user_id: created.user.id });
  if (claimError) {
    await admin.auth.admin.deleteUser(created.user.id);
    return jsonError(400, "invalid_code", "That code didn't work. It may have expired: make a new one.");
  }

  // Step 4: sign the tablet in (writes the session cookies).
  const supabase = await getSupabaseServerClient();
  const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
  if (signInError) {
    console.error("[board/pair] signIn", signInError.message);
    await admin.auth.admin.deleteUser(created.user.id);
    return jsonError(500, "pair_failed", "Couldn't sign the board in. Try again.");
  }
  return NextResponse.json({ ok: true });
}
