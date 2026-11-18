/**
 * The HomeHub voice helper: one request, start to finish (server only).
 *
 *   1. Send the request, the household context and the tools to Claude
 *      (Haiku 5.5).
 *   2. When Claude asks for a tool, run it with the CALLER'S OWN Supabase
 *      session: a phone acts as that person; the board acts as the board,
 *      so adding only works while a parent has it unlocked
 *      (board_add_entry). Every household rule still applies.
 *   3. Repeat until Claude answers (at most MAX_TURNS round trips), and
 *      return its short, speakable reply.
 *
 * The API key lives in Vercel (ANTHROPIC_API_KEY) and never reaches the
 * browser. Nothing is stored: not the words, not the reply.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { binLabel, type BinDay } from "../bins";
import { expandForRange } from "../calendar/expand";
import { addDays, timeKey } from "../calendar/time";
import type { CalendarEventRow } from "../calendar/types";
import { progressText, rewardStatus, type RewardPlan, type RewardProgress } from "../rewards";
import { balances, formatAmount, type WalletEntry } from "../wallet";
import {
  ASSISTANT_MODEL,
  MAX_TURNS,
  TOOLS,
  isIsoDate,
  matchList,
  matchMember,
  spokenError,
  systemPrompt,
  type AssistantContext,
  type HistoryTurn,
} from "./core";

const API_URL = "https://api.anthropic.com/v1/messages";

/** Anthropic message content blocks we use. */
type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };
type Message = { role: "user" | "assistant"; content: string | Block[] };

export interface AssistantResult {
  reply: string;
  /** Something was added (the screen refreshes its lists). */
  changed: boolean;
}

export async function runAssistant(
  supabase: SupabaseClient,
  ctx: AssistantContext,
  text: string,
  apiKey: string,
  history: HistoryTurn[] = [],
): Promise<AssistantResult> {
  // Step 0: the conversation so far (while the sheet is open), then the new question.
  const messages: Message[] = [...history.map((t) => ({ role: t.role, content: t.text })), { role: "user", content: text }];
  let changed = false;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    // Step 1: ask Claude.
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: ASSISTANT_MODEL, max_tokens: 400, system: systemPrompt(ctx), tools: TOOLS, messages }),
    });
    if (!res.ok) {
      console.error("[assistant] Claude API", res.status, (await res.text()).slice(0, 300));
      return { reply: "Sorry, I can't reach my helper right now. Try again in a moment.", changed };
    }
    const data = (await res.json()) as { content: Block[]; stop_reason: string };

    // Step 2: an answer? Done.
    const uses = data.content.filter((b): b is Extract<Block, { type: "tool_use" }> => b.type === "tool_use");
    if (data.stop_reason !== "tool_use" || uses.length === 0) {
      const reply = data.content
        .filter((b): b is Extract<Block, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join(" ")
        .trim();
      return { reply: reply || "Done.", changed };
    }

    // Step 3: run the tools Claude asked for, then go round again.
    messages.push({ role: "assistant", content: data.content });
    const results: Block[] = [];
    for (const use of uses) {
      const out = await runTool(supabase, ctx, use.name, use.input ?? {});
      if (out.changed) changed = true;
      results.push({ type: "tool_result", tool_use_id: use.id, content: out.text, is_error: out.error || undefined });
    }
    messages.push({ role: "user", content: results });
  }
  return { reply: "Sorry, that took too many steps. Try saying it a bit more simply.", changed };
}

// -----------------------------------------------------------------------------
// The tools
// -----------------------------------------------------------------------------
interface ToolOutput {
  text: string;
  changed?: boolean;
  error?: boolean;
}

const fail = (text: string): ToolOutput => ({ text, error: true });
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

async function runTool(supabase: SupabaseClient, ctx: AssistantContext, name: string, input: Record<string, unknown>): Promise<ToolOutput> {
  try {
    switch (name) {
      case "add_groceries":
        return await addGroceries(supabase, ctx, input);
      case "add_todo":
        return await addTodo(supabase, ctx, input);
      case "read_list":
        return await readList(supabase, ctx, input);
      case "agenda":
        return await agenda(supabase, ctx, input);
      case "star_progress":
        return await starProgress(supabase, ctx, input);
      default:
        return fail(`Unknown tool ${name}.`);
    }
  } catch (err) {
    console.error("[assistant] tool failed", name, err);
    return fail("That didn't work.");
  }
}

/** Add through the board's unlocked-session RPC, or a person's own add_entry. */
async function addEntry(supabase: SupabaseClient, ctx: AssistantContext, listId: string, text: string, due: string | null, assignee: string | null) {
  return ctx.isBoard
    ? supabase.rpc("board_add_entry", { p_list_id: listId, p_text: text, p_due_date: due, p_assigned_to: assignee })
    : supabase.rpc("add_entry", { p_list_id: listId, p_text: text, p_quantity: null, p_category: null, p_due_date: due, p_assigned_to: assignee });
}

// Tool 1: groceries.
async function addGroceries(supabase: SupabaseClient, ctx: AssistantContext, input: Record<string, unknown>): Promise<ToolOutput> {
  const items = (Array.isArray(input.items) ? input.items : []).map(str).filter(Boolean).slice(0, 15);
  if (items.length === 0) return fail("No items given.");
  const list = matchList(str(input.list) || undefined, ctx.lists, "shopping");
  if (!list) return fail("There's no shopping list yet.");
  const added: string[] = [];
  for (const item of items) {
    const { error } = await addEntry(supabase, ctx, list.id, item.slice(0, 200), null, null);
    if (error) return added.length ? { text: `Added ${added.join(", ")} to ${list.name}, then: ${spokenError(error.message)}`, changed: true } : fail(spokenError(error.message));
    added.push(item);
  }
  return { text: `Added ${added.join(", ")} to ${list.name}.`, changed: true };
}

// Tool 2: a to-do.
async function addTodo(supabase: SupabaseClient, ctx: AssistantContext, input: Record<string, unknown>): Promise<ToolOutput> {
  const text = str(input.text).slice(0, 200);
  if (!text) return fail("No task given.");
  const list = matchList(undefined, ctx.lists, "todo");
  if (!list) return fail("There's no to-do list yet.");
  const who = str(input.for_person);
  const member = matchMember(who || undefined, ctx.members);
  if (who && !member) return fail(`Nobody called ${who} in this family.`);
  const due = isIsoDate(input.due_date) ? input.due_date : null;
  const { error } = await addEntry(supabase, ctx, list.id, text, due, member?.id ?? null);
  if (error) return fail(spokenError(error.message));
  return { text: `Added to-do "${text}"${member ? ` for ${member.display_name.split(" ")[0]}` : ""}${due ? ` due ${due}` : ""}.`, changed: true };
}

// Tool 3: what's on a list.
async function readList(supabase: SupabaseClient, ctx: AssistantContext, input: Record<string, unknown>): Promise<ToolOutput> {
  const list = matchList(str(input.list) || undefined, ctx.lists);
  if (!list) return fail("No such list.");
  const { data, error } = await supabase
    .from("list_entries")
    .select("text, quantity, assigned_to, due_date")
    .eq("list_id", list.id)
    .eq("status", "open")
    .order("added_at")
    .limit(40);
  if (error) return fail(spokenError(error.message));
  const rows = (data ?? []) as Array<{ text: string; quantity: string | null; assigned_to: string | null; due_date: string | null }>;
  if (rows.length === 0) return { text: `${list.name} is empty.` };
  const line = (r: (typeof rows)[number]) => {
    const who = r.assigned_to ? ctx.members.find((m) => m.id === r.assigned_to)?.display_name.split(" ")[0] : null;
    return [r.quantity, r.text].filter(Boolean).join(" ") + (who ? ` (for ${who})` : "") + (r.due_date ? ` (due ${r.due_date})` : "");
  };
  return { text: `${list.name}, ${rows.length} open: ${rows.map(line).join("; ")}.` };
}

// Tool 4: calendar and bins.
async function agenda(supabase: SupabaseClient, ctx: AssistantContext, input: Record<string, unknown>): Promise<ToolOutput> {
  if (!isIsoDate(input.from) || !isIsoDate(input.to)) return fail("Dates must be YYYY-MM-DD.");
  const from = input.from;
  const to = input.to < from ? from : input.to > addDays(from, 30) ? addDays(from, 30) : input.to;

  // 4a. Events: one-offs in range, plus every series and moved occurrence
  //     (expandForRange works out which fall in range).
  const [{ data: events, error }, { data: bins }] = await Promise.all([
    supabase
      .from("calendar_events")
      .select("*")
      .or(
        `recurrence.not.is.null,recurring_event_id.not.is.null,and(start_at.gte.${from}T00:00:00Z,start_at.lte.${addDays(to, 1)}T23:59:59Z),and(start_date.gte.${addDays(from, -14)},start_date.lte.${to})`,
      )
      .limit(1000),
    supabase.from("bin_days").select("*").gte("date", from).lte("date", to).order("date"),
  ]);
  if (error) return fail(spokenError(error.message));
  const occurrences = expandForRange((events ?? []) as CalendarEventRow[], from, to, ctx.timeZone);

  // 4b. One line per day.
  const days = new Map<string, string[]>();
  const push = (day: string, s: string) => days.set(day, [...(days.get(day) ?? []), s]);
  for (const o of occurrences) {
    const day = o.startDate < from ? from : o.startDate;
    push(day, o.allDay || !o.start ? `${o.title} (all day)` : `${timeKey(o.start, ctx.timeZone)} ${o.title}`);
  }
  for (const b of (bins ?? []) as BinDay[]) push(b.date, `${binLabel(b.kind)} bin collected`);
  if (days.size === 0) return { text: `Nothing on the calendar and no bins from ${from} to ${to}.` };
  const label = (iso: string) =>
    new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${iso}T12:00:00Z`));
  return {
    text: [...days.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([d, items]) => `${label(d)} (${d}): ${items.join("; ")}`)
      .join("\n"),
  };
}

// Tool 5: rewards.
async function starProgress(supabase: SupabaseClient, ctx: AssistantContext, input: Record<string, unknown>): Promise<ToolOutput> {
  const kids = ctx.members.filter((m) => m.role === "child");
  const named = str(input.child);
  const pick = named ? matchMember(named, kids) : null;
  if (named && !pick) return fail(`No child called ${named}.`);
  const who = pick ? [pick] : kids;
  if (who.length === 0) return { text: "There are no children in the family." };

  const { data: plans } = await supabase
    .from("reward_plans")
    .select("*")
    .in(
      "member_id",
      who.map((k) => k.id),
    )
    .eq("active", true)
    .order("sort_order");
  // The wallets too: game time available, money owed.
  const { data: walletRows } = await supabase
    .from("wallet_entries")
    .select("member_id, unit, amount")
    .in(
      "member_id",
      who.map((k) => k.id),
    );
  const lines: string[] = [];
  for (const kid of who) {
    const bal = balances((walletRows ?? []) as Pick<WalletEntry, "member_id" | "unit" | "amount">[], kid.id);
    const hasWallet = ((walletRows ?? []) as Array<{ member_id: string }>).some((w) => w.member_id === kid.id);
    if (hasWallet) {
      lines.push(
        `${kid.display_name.split(" ")[0]}'s wallet: ${formatAmount("minutes", bal.minutes)} of game time available, ${formatAmount("euros", bal.euros)} owed.`,
      );
    }
    const own = ((plans ?? []) as RewardPlan[]).filter((p) => p.member_id === kid.id);
    const name = kid.display_name.split(" ")[0];
    if (own.length === 0) {
      lines.push(`${name}: no rewards set up.`);
      continue;
    }
    const { data: prog } = await supabase.rpc("reward_progress", { p_member_id: kid.id, p_today: ctx.today });
    const byPlan = new Map(((prog ?? []) as RewardProgress[]).map((r) => [r.plan_id, r]));
    for (const p of own) {
      const pr = byPlan.get(p.id);
      const status = rewardStatus(pr);
      lines.push(`${name}, ${p.title}: ${status === "earned" ? "earned, not given yet" : status === "given" ? "given" : progressText(p, pr)}.`);
    }
  }
  return { text: lines.join("\n") };
}
