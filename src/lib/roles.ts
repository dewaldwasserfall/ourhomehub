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

/** "Owner", "Adult" or "Child", for the Household screen. */
export function roleLabel(role: Member["role"]): string {
  return role === "owner" ? "Owner" : role === "child" ? "Child" : "Adult";
}
