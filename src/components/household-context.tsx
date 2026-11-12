/**
 * Makes the signed-in member, their household and its members available to
 * every client component under the (app) layout.
 */
"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import type { Household, Member } from "@/lib/types";

interface HouseholdContextValue {
  me: Member;
  household: Household;
  members: Member[];
  /** Look up a member by auth user id (for "added by" avatars). */
  memberByUserId: (userId: string | null) => Member | undefined;
  /** Update the household locally after a rename or new invite code. */
  setHousehold: (household: Household) => void;
}

const HouseholdContext = createContext<HouseholdContextValue | null>(null);

export function HouseholdProvider({
  me,
  household: initialHousehold,
  members,
  children,
}: {
  me: Member;
  household: Household;
  members: Member[];
  children: ReactNode;
}) {
  const [household, setHousehold] = useState(initialHousehold);

  const value = useMemo<HouseholdContextValue>(() => {
    const byUser = new Map(members.map((m) => [m.user_id, m]));
    return {
      me,
      household,
      members,
      memberByUserId: (userId) => (userId ? byUser.get(userId) : undefined),
      setHousehold,
    };
  }, [me, household, members]);

  return <HouseholdContext.Provider value={value}>{children}</HouseholdContext.Provider>;
}

export function useHousehold(): HouseholdContextValue {
  const ctx = useContext(HouseholdContext);
  if (!ctx) throw new Error("useHousehold must be used inside the (app) layout");
  return ctx;
}
