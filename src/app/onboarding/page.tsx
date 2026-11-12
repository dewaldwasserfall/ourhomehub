/**
 * Onboarding: shown once, right after the first Google sign-in.
 * The first person creates the household; the second joins with a code.
 */
import { redirect } from "next/navigation";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { OnboardingForm } from "./onboarding-form";

export default async function OnboardingPage() {
  const supabase = await getSupabaseServerClient();

  // Step 1: must be signed in.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // Step 2: already in a household? Nothing to do here.
  const { data: householdId } = await supabase.rpc("current_household_id");
  if (householdId) redirect("/");

  // Step 3: prefill from the Google profile.
  const meta = user.user_metadata ?? {};
  const firstName = String(meta.given_name ?? meta.full_name ?? meta.name ?? "").split(" ")[0];

  return (
    <OnboardingForm
      defaultName={firstName}
      avatarUrl={(meta.avatar_url as string | undefined) ?? (meta.picture as string | undefined) ?? null}
      email={user.email ?? ""}
    />
  );
}
