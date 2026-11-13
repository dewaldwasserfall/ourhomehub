/**
 * Shell for every signed-in screen.
 *
 * Gatekeeper: signed out -> /login, signed in without a household ->
 * /onboarding. Everyone else gets the household context, plus the tab bar
 * (phones and tablets) or the sidebar (desktop); CSS shows one or the other.
 */
import { redirect } from "next/navigation";
import { HouseholdProvider } from "@/components/household-context";
import { Sidebar } from "@/components/sidebar";
import { TabBar } from "@/components/tab-bar";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { HOUSEHOLD_COLUMNS, type Household, type Member } from "@/lib/types";

// Every screen depends on who is signed in: never cache.
export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await getSupabaseServerClient();

  // Step 1: who is this?
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // Step 2: which household are they in? (RLS only returns their own rows.)
  const { data: me } = await supabase.from("members").select("*").eq("user_id", user.id).maybeSingle<Member>();
  if (!me) redirect("/onboarding");

  // Step 3: the household and everyone in it.
  const [{ data: household }, { data: members }] = await Promise.all([
    // Explicit columns: the invite code is not readable from the browser.
    supabase.from("households").select(HOUSEHOLD_COLUMNS).eq("id", me.household_id).single<Household>(),
    supabase.from("members").select("*").order("created_at"),
  ]);
  if (!household) redirect("/onboarding");

  return (
    <HouseholdProvider me={me} household={household} members={(members as Member[]) ?? [me]}>
      <Sidebar />
      <div className="app-main">{children}</div>
      <TabBar />
    </HouseholdProvider>
  );
}
