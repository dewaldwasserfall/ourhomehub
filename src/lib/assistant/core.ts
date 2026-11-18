/**
 * The HomeHub voice helper: the parts that don't talk to anything.
 *
 *   * TOOLS: what Claude may do. Each maps to an action the app already has
 *     (add to a list, read a list, the agenda, reward progress), run with the
 *     caller's own sign-in so every household rule still applies.
 *   * systemPrompt(): who's in the family, today's date, the list names, and
 *     how to answer (short, spoken, no markdown).
 *   * matchMember() / matchList(): spoken names → rows ("Lenny" won't match,
 *     "lennon" and "Len" will).
 *   * spokenError(): database refusals → a sentence to read aloud.
 */

/** The model: small and fast is right for short household commands. */
export const ASSISTANT_MODEL = "claude-haiku-5-5";
/** Longest request we'll send (a spoken sentence or two). */
export const MAX_REQUEST_CHARS = 300;
/** Claude ↔ tool round trips per request, at most. */
export const MAX_TURNS = 4;

export interface AssistantMember {
  id: string;
  display_name: string;
  role: "owner" | "adult" | "child";
}

export interface AssistantList {
  id: string;
  name: string;
  type: "shopping" | "todo";
  is_default: boolean;
}

/** Context for one request. */
export interface AssistantContext {
  householdName: string;
  timeZone: string;
  today: string; // YYYY-MM-DD in the household's zone
  /** Who's asking: a person's first name, or "the Family board". */
  speaker: string;
  isBoard: boolean;
  members: AssistantMember[];
  lists: AssistantList[];
}

// -----------------------------------------------------------------------------
// Step 1: the tools (Anthropic tool-use format)
// -----------------------------------------------------------------------------
export const TOOLS = [
  {
    name: "add_groceries",
    description: "Add one or more items to a shopping list. Use the default shopping list unless the person names another one.",
    input_schema: {
      type: "object",
      properties: {
        items: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 15, description: "Each item as said, e.g. 'eggs', '2 litres of milk'." },
        list: { type: "string", description: "Shopping list name, only if the person named one." },
      },
      required: ["items"],
    },
  },
  {
    name: "add_todo",
    description: "Add a to-do, optionally for one person and with a due date.",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The task, short, e.g. 'Tidy your room'." },
        for_person: { type: "string", description: "First name of who it's for, if said." },
        due_date: { type: "string", description: "YYYY-MM-DD, if a day was said." },
      },
      required: ["text"],
    },
  },
  {
    name: "read_list",
    description: "What's still open on a list: a shopping list, or the to-dos.",
    input_schema: {
      type: "object",
      properties: { list: { type: "string", description: "List name, or 'to-dos'. Default: the default shopping list." } },
    },
  },
  {
    name: "agenda",
    description: "Calendar events and bin collections between two dates (inclusive, at most 31 days).",
    input_schema: {
      type: "object",
      properties: {
        from: { type: "string", description: "YYYY-MM-DD" },
        to: { type: "string", description: "YYYY-MM-DD" },
      },
      required: ["from", "to"],
    },
  },
  {
    name: "star_progress",
    description:
      "A child's rewards (stars or tasks so far, earned or given) and their wallet: minutes of game time available and money owed.",
    input_schema: {
      type: "object",
      properties: { child: { type: "string", description: "The child's first name; leave out for all children." } },
    },
  },
] as const;

export type ToolName = (typeof TOOLS)[number]["name"];

// -----------------------------------------------------------------------------
// Step 2: the instructions
// -----------------------------------------------------------------------------
const longDate = (iso: string) =>
  new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${iso}T12:00:00Z`));

export function systemPrompt(ctx: AssistantContext): string {
  const people = ctx.members.map((m) => `${m.display_name.split(" ")[0]} (${m.role === "child" ? "child" : "adult"})`).join(", ");
  const lists = ctx.lists.map((l) => `${l.name}${l.type === "todo" ? " (to-dos)" : l.is_default ? " (default shopping list)" : " (shopping)"}`).join(", ");
  return [
    `You are the voice helper in HomeHub, the ${ctx.householdName} family's household app.`,
    `Today is ${longDate(ctx.today)} (${ctx.today}), time zone ${ctx.timeZone}. Weeks run Monday to Sunday.`,
    `You're talking to ${ctx.speaker}.`,
    `Family: ${people || "unknown"}.`,
    `Lists: ${lists || "none yet"}.`,
    "",
    "How to answer:",
    "- Your reply is read aloud. One or two short, friendly sentences. No markdown, lists, emoji or links.",
    "- Use the tools to act or look things up. Never say you did something unless the tool said it worked.",
    "- If a tool reports a problem (for example the board is locked), say so plainly in one sentence.",
    "- Work out dates yourself from today's date ('tomorrow', 'Saturday', 'next week').",
    "- If the request is unclear (which person, which list), ask one short question instead of guessing.",
    "- Only help with this household: lists, to-dos, the calendar, bins and rewards. For anything else, say briefly that you can only help with HomeHub things.",
  ].join("\n");
}

// -----------------------------------------------------------------------------
// Step 3: spoken names → rows
// -----------------------------------------------------------------------------
const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // "Anél" ↔ "anel"
    .replace(/[^a-z0-9 ]/g, "")
    .trim();

/** A person by first name (or the start of it, at least 3 letters). */
export function matchMember(spoken: string | undefined, members: AssistantMember[]): AssistantMember | null {
  if (!spoken) return null;
  const want = norm(spoken).replace(/^(for|to) /, "");
  if (!want) return null;
  const first = (m: AssistantMember) => norm(m.display_name.split(" ")[0]);
  return (
    members.find((m) => first(m) === want) ??
    members.find((m) => norm(m.display_name) === want) ??
    (want.length >= 3 ? (members.find((m) => first(m).startsWith(want)) ?? null) : null)
  );
}

/**
 * A list by spoken name. Shopping lists fall back to the default one; asking
 * for "to-dos", "todo" or "tasks" finds the to-do list.
 */
export function matchList(spoken: string | undefined, lists: AssistantList[], type: "shopping" | "todo" | "any" = "any"): AssistantList | null {
  const pool = type === "any" ? lists : lists.filter((l) => l.type === type);
  const want = spoken ? norm(spoken).replace(/\b(the|list|my|our)\b/g, "").trim() : "";
  if (want) {
    const exact = pool.find((l) => norm(l.name) === want);
    if (exact) return exact;
    const partial = pool.find((l) => norm(l.name).includes(want) || want.includes(norm(l.name)));
    if (partial) return partial;
    if (/^(to ?dos?|tasks?)$/.test(want)) return lists.find((l) => l.type === "todo") ?? null;
    if (/^(groceries|grocery|shopping)$/.test(want)) return pool.find((l) => l.type === "shopping" && l.is_default) ?? pool.find((l) => l.type === "shopping") ?? null;
  }
  if (type === "todo") return pool[0] ?? null;
  return pool.find((l) => l.type === "shopping" && l.is_default) ?? pool.find((l) => l.type === "shopping") ?? null;
}

/** "YYYY-MM-DD" and a real date? */
export function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

// -----------------------------------------------------------------------------
// Step 4: database refusals → spoken sentences
// -----------------------------------------------------------------------------
export function spokenError(message: string): string {
  if (message.includes("board_locked")) return "The board is locked. A grown-up needs to unlock it with their PIN first.";
  if (message.includes("adults_only") || message.includes("not_allowed") || message.includes("row-level security"))
    return "Only grown-ups can do that.";
  if (message.includes("not_a_board")) return "That only works on the Family board.";
  return "That didn't work. Please try again.";
}

// -----------------------------------------------------------------------------
// Step 5: a short conversation (while the sheet is open)
// -----------------------------------------------------------------------------

/** Earlier turns sent along with a question: the last three exchanges. */
export const MAX_HISTORY_TURNS = 6;
const MAX_TURN_CHARS = 600;

export interface HistoryTurn {
  role: "user" | "assistant";
  text: string;
}

/**
 * The earlier turns from the browser, made safe to send to Claude: only
 * "user" / "assistant" text, each trimmed and capped, the most recent
 * MAX_HISTORY_TURNS, starting with a question and alternating (Claude's
 * API needs that). Anything malformed is dropped rather than refused.
 */
export function cleanHistory(raw: unknown): HistoryTurn[] {
  if (!Array.isArray(raw)) return [];
  const turns: HistoryTurn[] = [];
  for (const t of raw.slice(-MAX_HISTORY_TURNS * 2)) {
    const role = (t as { role?: unknown })?.role;
    const text = (t as { text?: unknown })?.text;
    if ((role !== "user" && role !== "assistant") || typeof text !== "string" || !text.trim()) continue;
    // Keep strict turn-taking: a repeated role replaces the one before.
    if (turns.length && turns[turns.length - 1].role === role) turns.pop();
    turns.push({ role, text: text.trim().slice(0, MAX_TURN_CHARS) });
  }
  let recent = turns.slice(-MAX_HISTORY_TURNS);
  while (recent.length && recent[0].role !== "user") recent = recent.slice(1);
  // The new question follows, so the history must end with an answer.
  while (recent.length && recent[recent.length - 1].role !== "assistant") recent = recent.slice(0, -1);
  return recent;
}

/** Did the helper ask something back? (Then the mic opens again by itself.) */
export function asksBack(reply: string): boolean {
  return /\?["'”’)\s]*$/.test(reply.trim());
}
