/**
 * Makes the signed-in member, their household and its members available to
 * every client component under the (app) layout.
 */
"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { isAdult } from "@/lib/roles";
import { applyTheme, themeAttributes } from "@/lib/themes";
import type { Household, Member } from "@/lib/types";

interface HouseholdContextValue {
  me: Member;
  household: Household;
  members: Member[];
  /** Owners and adults; false for children (read and tick only). */
  meIsAdult: boolean;
  /** Look up a member by auth user id (for "added by" avatars). */
  memberByUserId: (userId: string | null) => Member | undefined;
  /** Look up a member by member id (assignees, routine owners). */
  memberById: (memberId: string | null) => Member | undefined;
  /** Update the household locally after a rename or a settings change. */
  setHousehold: (household: Household) => void;
  /** Update the signed-in member locally (e.g. after a theme change). */
  updateMe: (patch: Partial<Member>) => void;
}

const HouseholdContext = createContext<HouseholdContextValue | null>(null);

export function HouseholdProvider({
  me: initialMe,
  household: initialHousehold,
  members: initialMembers,
  children,
}: {
  me: Member;
  household: Household;
  members: Member[];
  children: ReactNode;
}) {
  const [household, setHousehold] = useState(initialHousehold);
  const [me, setMe] = useState(initialMe);
  const [members, setMembers] = useState(initialMembers);

  // Step 1: the theme on this device follows the member row. On a new device
  // (or after changing theme on another one) the cookie is out of date, so
  // apply the saved theme now; later page loads render it straight away.
  useEffect(() => {
    const want = themeAttributes(me.theme_accent, me.theme_mode);
    const root = document.documentElement;
    if (root.getAttribute("data-accent") !== want["data-accent"] || root.getAttribute("data-mode") !== (want["data-mode"] ?? null)) {
      applyTheme(me.theme_accent, me.theme_mode);
    }
  }, [me.theme_accent, me.theme_mode]);

  // Step 2: local updates to "me" also update their entry in the members list.
  const updateMe = useCallback((patch: Partial<Member>) => {
    setMe((current) => ({ ...current, ...patch }));
    setMembers((list) => list.map((m) => (m.id === initialMe.id ? { ...m, ...patch } : m)));
  }, [initialMe.id]);

  const value = useMemo<HouseholdContextValue>(() => {
    const byUser = new Map(members.map((m) => [m.user_id, m]));
    const byId = new Map(members.map((m) => [m.id, m]));
    return {
      me,
      household,
      members,
      meIsAdult: isAdult(me),
      memberByUserId: (userId) => (userId ? byUser.get(userId) : undefined),
      memberById: (memberId) => (memberId ? byId.get(memberId) : undefined),
      setHousehold,
      updateMe,
    };
  }, [me, household, members, updateMe]);

  return <HouseholdContext.Provider value={value}>{children}</HouseholdContext.Provider>;
}

export function useHousehold(): HouseholdContextValue {
  const ctx = useContext(HouseholdContext);
  if (!ctx) throw new Error("useHousehold must be used inside the (app) layout");
  return ctx;
}
