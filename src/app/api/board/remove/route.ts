/**
 * POST /api/board/remove   { boardId }
 *
 * Unpairs a Family board (adults). Deleting the board's sign-in also deletes
 * its boards row (on delete cascade), and the tablet is signed out the next
 * time it talks to HomeHub.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getCaller, jsonError } from "@/lib/calendar/caller";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  // Step 1: adults only.
  const result = await getCaller({ adultOnly: true });
  if (!result.ok) return result.response;

  // Step 2: the board must be in the caller's household (read with their own
  // session, so RLS decides).
  const body = (await request.json().catch(() => null)) as { boardId?: unknown } | null;
  const boardId = typeof body?.boardId === "string" ? body.boardId : "";
  const supabase = await getSupabaseServerClient();
  const { data: board } = await supabase.from("boards").select("id, user_id").eq("id", boardId).maybeSingle<{ id: string; user_id: string }>();
  if (!board) return jsonError(404, "not_found", "That board isn't paired any more.");

  // Step 3: remove its sign-in (and with it the board).
  const { error } = await getSupabaseAdminClient().auth.admin.deleteUser(board.user_id);
  if (error) return jsonError(500, "remove_failed", "Couldn't remove the board. Try again.");
  return NextResponse.json({ ok: true });
}
