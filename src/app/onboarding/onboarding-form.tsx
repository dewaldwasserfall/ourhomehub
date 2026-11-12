/**
 * Create-or-join form for onboarding.
 */
"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Segmented } from "@/components/segmented";
import { friendlyError } from "@/lib/errors";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

type Mode = "create" | "join";

interface Props {
  defaultName: string;
  avatarUrl: string | null;
  email: string;
}

export function OnboardingForm({ defaultName, avatarUrl, email }: Props) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("create");
  const [displayName, setDisplayName] = useState(defaultName);
  const [householdName, setHouseholdName] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const supabase = getSupabaseBrowserClient();

    // Step 1: call the matching RPC. Both create the membership server-side.
    const { error: rpcError } =
      mode === "create"
        ? await supabase.rpc("create_household", {
            p_name: householdName || "Our home",
            p_display_name: displayName,
            p_avatar_url: avatarUrl,
          })
        : await supabase.rpc("join_household", {
            p_invite_code: inviteCode,
            p_display_name: displayName,
            p_avatar_url: avatarUrl,
          });

    // Step 2: show what went wrong, or go to the lists.
    if (rpcError) {
      setError(friendlyError(rpcError));
      setBusy(false);
      return;
    }
    router.replace("/");
    router.refresh();
  }

  const canSubmit = displayName.trim().length > 0 && (mode === "create" || inviteCode.replace(/\s/g, "").length === 6);

  return (
    <main className="welcome">
      <h1 className="welcome__title">Set up your home</h1>
      <p className="welcome__lede">
        {mode === "create"
          ? "Start a household, then invite your partner with a six-character code."
          : "Enter the code from the Household tab on your partner's phone."}
      </p>

      <form onSubmit={submit} style={{ marginTop: 32 }} className="sheet__stack">
        <Segmented
          label="Create or join"
          value={mode}
          onChange={(m) => {
            setMode(m);
            setError(null);
          }}
          options={[
            { value: "create", label: "Start a household" },
            { value: "join", label: "Join with a code" },
          ]}
        />

        <label className="field">
          <span className="field__label">Your name</span>
          <input
            className="input"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            autoComplete="given-name"
            maxLength={40}
            required
          />
        </label>

        {mode === "create" ? (
          <label className="field">
            <span className="field__label">Household name</span>
            <input
              className="input"
              value={householdName}
              onChange={(e) => setHouseholdName(e.target.value)}
              placeholder="Our home"
              maxLength={60}
            />
          </label>
        ) : (
          <label className="field">
            <span className="field__label">Invite code</span>
            <input
              className="input"
              value={inviteCode}
              onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
              placeholder="ABC123"
              autoCapitalize="characters"
              autoComplete="one-time-code"
              spellCheck={false}
              maxLength={8}
              style={{ letterSpacing: "0.2em", fontWeight: 600 }}
              required
            />
          </label>
        )}

        <div>
          <button type="submit" className="button button--primary" disabled={!canSubmit || busy}>
            {busy && <span className="spinner" aria-hidden="true" />}
            {mode === "create" ? "Create household" : "Join household"}
          </button>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
        </div>
      </form>

      <p className="welcome__fineprint" style={{ marginTop: "auto", paddingTop: 32 }}>
        Signed in as {email}
      </p>
    </main>
  );
}
