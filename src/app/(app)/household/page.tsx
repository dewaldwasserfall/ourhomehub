/**
 * Household tab: who's in it, the invite code, and signing out.
 */
"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Avatar } from "@/components/avatar";
import { useHousehold } from "@/components/household-context";
import { RefreshIcon, ShareIcon } from "@/components/icons";
import { Navbar } from "@/components/navbar";
import { friendlyError } from "@/lib/errors";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

export default function HouseholdPage() {
  const router = useRouter();
  const { household, members, me, setHousehold } = useHousehold();
  const [name, setName] = useState(household.name);
  const [shareLabel, setShareLabel] = useState("Share");
  const [error, setError] = useState<string | null>(null);
  const supabase = getSupabaseBrowserClient();

  // Step 1: rename the household when the field loses focus.
  async function saveName() {
    const trimmed = name.trim();
    if (!trimmed || trimmed === household.name) {
      setName(household.name);
      return;
    }
    const { error: updateError } = await supabase.from("households").update({ name: trimmed }).eq("id", household.id);
    if (updateError) {
      setError(friendlyError(updateError));
      setName(household.name);
      return;
    }
    setHousehold({ ...household, name: trimmed });
  }

  // Step 2: share the invite code (native share sheet, else copy).
  async function shareCode() {
    const text = `Join our household in Household Hub with code ${household.invite_code}: ${window.location.origin}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: "Household Hub invite", text });
        return;
      }
      await navigator.clipboard.writeText(household.invite_code);
      setShareLabel("Copied");
      setTimeout(() => setShareLabel("Share"), 1800);
    } catch {
      // The person closed the share sheet: nothing to do.
    }
  }

  // Step 3: issue a new code (the old one stops working immediately).
  async function newCode() {
    const { data, error: rpcError } = await supabase.rpc("regenerate_invite_code");
    if (rpcError) {
      setError(friendlyError(rpcError));
      return;
    }
    setHousehold({ ...household, invite_code: data as string });
  }

  async function signOut() {
    await supabase.auth.signOut();
    router.replace("/login");
    router.refresh();
  }

  return (
    <main className="screen">
      <Navbar title="Household" />

      {/* Household name */}
      <section className="section">
        <label className="field">
          <span className="field__label">Household name</span>
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={saveName}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            maxLength={60}
          />
        </label>
      </section>

      {/* Members */}
      <section className="section">
        <div className="section__header">
          <span className="section__header-title">Members</span>
          <span>{members.length} of 8</span>
        </div>
        <div className="group">
          {members.map((member) => (
            <div key={member.id} className="row" style={{ ["--separator-inset" as string]: "70px" }}>
              <Avatar member={member} />
              <div className="row__body">
                <span className="row__title">
                  {member.display_name}
                  {member.id === me.id && <span style={{ color: "var(--ink-2)" }}> (you)</span>}
                </span>
                {member.email && <span className="row__subtitle">{member.email}</span>}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Invite */}
      <section className="section">
        <div className="section__header">
          <span className="section__header-title">Invite someone</span>
        </div>
        <div className="invite">
          <p className="invite__caption">They sign in with Google, choose Join with a code, and enter:</p>
          <div className="invite__code" aria-label={`Invite code ${household.invite_code.split("").join(" ")}`}>
            {household.invite_code.split("").map((char, i) => (
              <span key={i} className="invite__char" aria-hidden="true">
                {char}
              </span>
            ))}
          </div>
          <div className="invite__actions">
            <button type="button" className="button button--secondary" onClick={shareCode}>
              <ShareIcon size={20} />
              {shareLabel}
            </button>
            <button type="button" className="button button--secondary" onClick={newCode}>
              <RefreshIcon size={20} />
              New code
            </button>
          </div>
        </div>
        <p className="section__footer">
          Their Google account also has to be on the allowlist in Supabase. A new code stops the old one working.
        </p>
      </section>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      <section className="section">
        <button type="button" className="button button--danger" onClick={signOut}>
          Sign out
        </button>
      </section>
    </main>
  );
}
