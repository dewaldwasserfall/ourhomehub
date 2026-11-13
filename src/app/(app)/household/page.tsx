/**
 * Household tab: who's in it, your own theme, the household's plan (routines,
 * zones, chores, school holidays), the invite code, the family calendar link,
 * and signing out.
 *
 * Children see the members, the calendar status and Sign out; renaming, the
 * plan and the invite code are for adults (the database enforces the same).
 */
"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Avatar } from "@/components/avatar";
import { FamilyCalendarCard } from "@/components/family-calendar-card";
import { useHousehold } from "@/components/household-context";
import {
  BellIcon,
  BinIcon,
  ChevronRightIcon,
  ChoreIcon,
  HolidayIcon,
  RefreshIcon,
  RoutineIcon,
  ShareIcon,
  StarIcon,
  WalletIcon,
  ZoneIcon,
} from "@/components/icons";
import { Navbar } from "@/components/navbar";
import { ThemePicker } from "@/components/theme-picker";
import { friendlyError } from "@/lib/errors";
import { canSeeFinances, roleLabel } from "@/lib/roles";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

/** The four planning screens, each a row with a coloured icon. */
const PLAN_LINKS = [
  { href: "/household/routines", title: "Routines", subtitle: "Morning, after-school and evening checklists", Icon: RoutineIcon, colour: "#ff9500" },
  { href: "/household/zones", title: "Zones", subtitle: "One part of the house each fortnight", Icon: ZoneIcon, colour: "#5856d6" },
  { href: "/household/chores", title: "Chores", subtitle: "Jobs that come round every few days or weeks", Icon: ChoreIcon, colour: "#34aadc" },
  { href: "/stars", title: "Stars and rewards", subtitle: "What the kids earn for ticking things off", Icon: StarIcon, colour: "#ffb800" },
  { href: "/household/bins", title: "Bin days", subtitle: "Collection dates from the Afvalservice app", Icon: BinIcon, colour: "#2f9e44" },
  { href: "/household/holidays", title: "School holidays", subtitle: "Holidays, public holidays and days off", Icon: HolidayIcon, colour: "#ff2d55" },
];

export default function HouseholdPage() {
  const router = useRouter();
  const { household, members, me, meIsAdult, setHousehold } = useHousehold();
  const [name, setName] = useState(household.name);
  const [inviteCode, setInviteCode] = useState<string | null>(null);
  const [shareLabel, setShareLabel] = useState("Share");
  const [error, setError] = useState<string | null>(null);
  const supabase = getSupabaseBrowserClient();

  // Step 1: adults fetch the invite code (it isn't a readable column).
  useEffect(() => {
    if (!meIsAdult) return;
    supabase.rpc("household_invite_code").then(({ data }) => setInviteCode((data as string) ?? null));
  }, [supabase, meIsAdult]);

  // Step 2: rename the household when the field loses focus.
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

  // Step 3: share the invite code (native share sheet, else copy).
  async function shareCode() {
    if (!inviteCode) return;
    const text = `Join our household in HomeHub with code ${inviteCode}: ${window.location.origin}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: "HomeHub invite", text });
        return;
      }
      await navigator.clipboard.writeText(inviteCode);
      setShareLabel("Copied");
      setTimeout(() => setShareLabel("Share"), 1800);
    } catch {
      // The person closed the share sheet: nothing to do.
    }
  }

  // Step 4: issue a new code (the old one stops working immediately).
  async function newCode() {
    const { data, error: rpcError } = await supabase.rpc("regenerate_invite_code");
    if (rpcError) {
      setError(friendlyError(rpcError));
      return;
    }
    setInviteCode(data as string);
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
            readOnly={!meIsAdult}
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
              <span className="row__trailing">{roleLabel(member.role)}</span>
            </div>
          ))}
        </div>
      </section>

      {/* Everyone's own colours and reminders */}
      <ThemePicker />

      <section className="section">
        <div className="group">
          <Link href="/household/notifications" className="row row--link">
            <span className="row__icon" style={{ background: "#ff3b30" }}>
              <BellIcon size={19} strokeWidth={2} />
            </span>
            <span className="row__body">
              <span className="row__title">Notifications</span>
              <span className="row__subtitle">Reminders on your phone, just for you</span>
            </span>
            <ChevronRightIcon className="row__chevron" size={16} />
          </Link>
        </div>
      </section>

      {/* Grocery budget (only for those the owner gave access) */}
      {canSeeFinances(me) && (
        <section className="section">
          <div className="group">
            <Link href="/budget" className="row row--link">
              <span className="row__icon" style={{ background: "#0a84ff" }}>
                <WalletIcon size={19} strokeWidth={2} />
              </span>
              <span className="row__body">
                <span className="row__title">Groceries budget</span>
                <span className="row__subtitle">From the bunq groceries account</span>
              </span>
              <ChevronRightIcon className="row__chevron" size={16} />
            </Link>
          </div>
        </section>
      )}

      {/* The household's plan (adults) */}
      {meIsAdult && (
        <section className="section">
          <div className="section__header">
            <span className="section__header-title">Plan</span>
          </div>
          <div className="group">
            {PLAN_LINKS.map(({ href, title, subtitle, Icon, colour }) => (
              <Link key={href} href={href} className="row row--link">
                <span className="row__icon" style={{ background: colour }}>
                  <Icon size={19} strokeWidth={2} />
                </span>
                <span className="row__body">
                  <span className="row__title">{title}</span>
                  <span className="row__subtitle">{subtitle}</span>
                </span>
                <ChevronRightIcon className="row__chevron" size={16} />
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* Invite (adults) */}
      {meIsAdult && (
        <section className="section">
          <div className="section__header">
            <span className="section__header-title">Invite someone</span>
          </div>
          <div className="invite">
            <p className="invite__caption">They sign in with Google, choose Join with a code, and enter:</p>
            <div
              className="invite__code"
              aria-label={inviteCode ? `Invite code ${inviteCode.split("").join(" ")}` : "Loading invite code"}
            >
              {(inviteCode ?? "      ").split("").map((char, i) => (
                <span key={i} className="invite__char" aria-hidden="true">
                  {char}
                </span>
              ))}
            </div>
            <div className="invite__actions">
              <button type="button" className="button button--secondary" onClick={shareCode} disabled={!inviteCode}>
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
            Their Google account also has to be on the allowlist in Supabase, which also says whether they join as an adult
            or a child. A new code stops the old one working.
          </p>
        </section>
      )}

      {/* Family calendar */}
      <FamilyCalendarCard
        isOwner={me.role === "owner"}
        ownerName={members.find((m) => m.role === "owner")?.display_name ?? "The owner"}
      />

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
