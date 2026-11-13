/**
 * Sign-in screen. One button: continue with Google.
 * Errors from the auth callback arrive as ?error=<code>.
 */
import Image from "next/image";
import { redirect } from "next/navigation";
import { CartIcon, RhythmIcon, HomeIcon } from "@/components/icons";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { GoogleSignInButton } from "./google-sign-in-button";

const ERRORS: Record<string, string> = {
  not_allowed:
    "That Google account doesn't have access. It may not be on the allowlist, or its access period has ended. Ask whoever set up the app.",
  auth_failed: "Google sign-in didn't complete. Try again.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  // Step 1: already signed in? Skip straight to the app.
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) redirect("/");

  const { error } = await searchParams;
  const errorMessage = error ? (ERRORS[error] ?? ERRORS.auth_failed) : null;

  // Step 2: render the welcome screen.
  return (
    <main className="welcome">
      <Image
        className="welcome__icon"
        src="/icons/icon-rounded-256.png"
        alt=""
        width={72}
        height={72}
        priority
      />
      <h1 className="welcome__title">HomeHub</h1>
      <p className="welcome__lede">One shared list for the two of you, with a memory for what runs out.</p>

      <ul className="welcome__features">
        <li className="welcome__feature">
          <span className="welcome__feature-icon">
            <CartIcon />
          </span>
          <span>
            <strong>Shop together, live</strong>
            Add milk on your phone and it appears on theirs while they're still in the shop.
          </span>
        </li>
        <li className="welcome__feature">
          <span className="welcome__feature-icon">
            <RhythmIcon />
          </span>
          <span>
            <strong>Learns your rhythms</strong>
            After a few shops it knows coffee goes every ten days and adds it before you run out.
          </span>
        </li>
        <li className="welcome__feature">
          <span className="welcome__feature-icon">
            <HomeIcon />
          </span>
          <span>
            <strong>Private to your home</strong>
            Only the Google accounts you invite can see your household.
          </span>
        </li>
      </ul>

      <div className="welcome__footer">
        {errorMessage && (
          <p className="form-error" role="alert">
            {errorMessage}
          </p>
        )}
        <GoogleSignInButton />
        <p className="welcome__fineprint">You&rsquo;ll create a household or join one next.</p>
      </div>
    </main>
  );
}
