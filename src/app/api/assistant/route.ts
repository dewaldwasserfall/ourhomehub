/**
 * POST /api/assistant   { text: "add eggs to the grocery list", history?: [{ role, text }] }
 *   → { reply: "Added eggs to Groceries.", changed: true }
 *
 * The voice helper (see src/lib/assistant). Works for:
 *   * a person on their phone: acts as them (adults add; children can only
 *     ask questions, because add_entry is adults-only);
 *   * the Family board: questions for anyone; adding only while a parent
 *     has unlocked the board with their PIN.
 *
 * Uses the caller's own session cookie, never the service key, so the
 * database's rules decide what each request may do.
 */
import { NextResponse, type NextRequest } from "next/server";
import { MAX_REQUEST_CHARS, cleanHistory, type AssistantContext, type AssistantList, type AssistantMember } from "@/lib/assistant/core";
import { runAssistant } from "@/lib/assistant/run";
import { jsonError } from "@/lib/calendar/caller";
import { dateKey } from "@/lib/calendar/time";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  // Step 0: set up?
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return jsonError(503, "not_configured", "The voice helper isn't set up yet.");

  // Step 1: what was said.
  //         Plus the conversation so far, while the sheet is open (the
  //         browser keeps it; nothing is stored here).
  const body = (await request.json().catch(() => null)) as { text?: unknown; history?: unknown } | null;
  const text = typeof body?.text === "string" ? body.text.trim().slice(0, MAX_REQUEST_CHARS) : "";
  const history = cleanHistory(body?.history);
  if (!text) return jsonError(400, "empty", "I didn't catch that.");

  // Step 2: who's asking: a person, or a board?
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return jsonError(401, "not_authenticated", "Your session ended. Sign in again.");
  const [{ data: me }, { data: board }] = await Promise.all([
    supabase.from("members").select("id, display_name, household_id").eq("user_id", user.id).maybeSingle<{ id: string; display_name: string; household_id: string }>(),
    supabase.from("boards").select("id, household_id").eq("user_id", user.id).maybeSingle<{ id: string; household_id: string }>(),
  ]);
  const householdId = me?.household_id ?? board?.household_id;
  if (!householdId) return jsonError(403, "not_in_household", "This device isn't part of a household.");

  // Step 3: the household context (RLS: own household only).
  const [{ data: household }, { data: members }, { data: lists }] = await Promise.all([
    supabase.from("households").select("name, timezone").eq("id", householdId).single<{ name: string; timezone: string }>(),
    supabase.from("members").select("id, display_name, role").order("created_at"),
    supabase.from("lists").select("id, name, type, is_default").order("sort_order"),
  ]);
  if (!household) return jsonError(403, "not_in_household", "This device isn't part of a household.");
  const ctx: AssistantContext = {
    householdName: household.name,
    timeZone: household.timezone,
    today: dateKey(new Date(), household.timezone),
    speaker: me ? me.display_name.split(" ")[0] : "someone at the Family board",
    isBoard: !me && !!board,
    members: (members ?? []) as AssistantMember[],
    lists: (lists ?? []) as AssistantList[],
  };

  // Step 4: ask, act, answer.
  const result = await runAssistant(supabase, ctx, text, apiKey, history);
  return NextResponse.json(result);
}
