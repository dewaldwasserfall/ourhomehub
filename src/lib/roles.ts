/**
 * What each role may do, as the screens see it.
 *
 * The database enforces the same rules (RLS, set_completion(), the
 * list_entries child guard); these helpers only decide what to show, so a
 * child never sees a button that would be refused.
 */
import type { Member } from "./types";

/** Owners and adults run the household. */
export function isAdult(member: Pick<Member, "role">): boolean {
  return member.role === "owner" || member.role === "adult";
}

/**
 * May this member tick off something assigned to `assigneeId`?
 * Adults: anything. Children: only their own (unassigned counts as not theirs).
 */
export function canTick(member: Pick<Member, "id" | "role">, assigneeId: string | null): boolean {
  return isAdult(member) || (assigneeId !== null && assigneeId === member.id);
}

/** Sees the grocery budget: the owner always, adults the owner chose. */
export function canSeeFinances(member: Pick<Member, "role" | "can_see_finances">): boolean {
  return member.role === "owner" || (member.role === "adult" && member.can_see_finances);
}

/** Sees Trips: the owner always, anyone else the owner chose. */
export function canSeeTrips(member: Pick<Member, "role" | "can_see_trips">): boolean {
  return member.role === "owner" || Boolean(member.can_see_trips);
}

/** Changes Trips: adults with access (children only ever read). */
export function canEditTrips(member: Pick<Member, "role" | "can_see_trips">): boolean {
  return canSeeTrips(member) && isAdult(member);
}

/** "Owner", "Adult" or "Child", for the Household screen. */
export function roleLabel(role: Member["role"]): string {
  return role === "owner" ? "Owner" : role === "child" ? "Child" : "Adult";
}
