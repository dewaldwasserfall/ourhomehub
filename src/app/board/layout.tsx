/**
 * Shell for the Family board (a wall tablet).
 *
 *   * Not signed in, or signed in as a person: the pairing screen (a person's
 *     phone shouldn't become the board by accident; they're sent home).
 *   * Signed in as a board: the household context, with a stand-in "me" that
 *     reads like a child (so shared screens such as the calendar are
 *     read-only), and the board's own tabs. No tab bar, no sidebar.
 */
import { redirect } from "next/navigation";
import { BoardPair } from "@/components/board/board-pair";
import { BoardShell } from "@/components/board/board-shell";
import { HouseholdProvider } from "@/components/household-context";
import { ServiceWorker } from "@/components/service-worker";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { HOUSEHOLD_COLUMNS, type Household, type Member } from "@/lib/types";

export const dynamic = "force-dynamic";

export const metadata = { title: "Family board · HomeHub" };

export default async function BoardLayout({ children }: { children: React.ReactNode }) {
  const supabase = await getSupabaseServerClient();

  // Step 1: who is this?
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return <BoardPair />;

  // Step 2: a board? (A person signed in on this device goes to their Today.)
  const { data: board } = await supabase
    .from("boards")
    .select("id, name, household_id")
    .eq("user_id", user.id)
    .maybeSingle<{ id: string; name: string; household_id: string }>();
  if (!board) redirect("/");

  // Step 3: the household and everyone in it.
  const [{ data: household }, { data: members }] = await Promise.all([
    supabase.from("households").select(HOUSEHOLD_COLUMNS).eq("id", board.household_id).single<Household>(),
    supabase.from("members").select("*").order("created_at"),
  ]);
  if (!household) return <BoardPair />;
  const people = (members as Member[]) ?? [];

  // Step 4: the stand-in "me": child-level (read and tick only), in the
  //         owner's colours.
  const owner = people.find((m) => m.role === "owner");
  const me: Member = {
    id: board.id,
    household_id: household.id,
    user_id: user.id,
    display_name: board.name,
    email: null,
    avatar_url: null,
    role: "child",
    theme_accent: owner?.theme_accent ?? "basil",
    theme_mode: owner?.theme_mode ?? "system",
    can_see_finances: false,
    can_see_trips: false,
    created_at: household.created_at,
  };

  return (
    <HouseholdProvider me={me} household={household} members={people}>
      <BoardShell boardName={board.name}>{children}</BoardShell>
      <ServiceWorker />
    </HouseholdProvider>
  );
}
