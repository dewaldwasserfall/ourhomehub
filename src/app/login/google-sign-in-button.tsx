/**
 * Starts the Google OAuth flow through Supabase. Google sends the user back
 * to /auth/callback, which finishes the sign-in.
 */
"use client";

import { useState } from "react";
import { GoogleIcon } from "@/components/icons";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

export function GoogleSignInButton() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn() {
    setBusy(true);
    setError(null);

    // Step 1: ask Supabase for the Google consent URL and go there.
    const { error: oauthError } = await getSupabaseBrowserClient().auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
        // Always show the account picker: handy on a shared family laptop.
        queryParams: { prompt: "select_account" },
      },
    });

    // Step 2: only reached if the redirect could not start.
    if (oauthError) {
      setError("Couldn't reach Google. Check your connection and try again.");
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" className="button button--google" onClick={signIn} disabled={busy}>
        {busy ? <span className="spinner" aria-hidden="true" /> : <GoogleIcon />}
        Continue with Google
      </button>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
