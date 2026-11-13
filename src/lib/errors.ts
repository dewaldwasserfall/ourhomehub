/**
 * Maps error codes raised by the database RPCs to interface copy.
 * Each message says what happened and what to do next.
 */
const MESSAGES: Record<string, string> = {
  email_not_allowed:
    "This Google account isn't on the household's allowlist. Ask the person who set up the app to add it.",
  already_in_household: "You're already in a household. Open the app to see it.",
  invite_code_not_found: "That invite code doesn't match a household. Check the six characters and try again.",
  household_full: "This household already has the maximum of 8 members.",
  not_in_household: "Join or create a household first.",
  list_not_found: "That list no longer exists. Go back to Lists and pick another.",
  empty_text: "Type something to add.",
  not_authenticated: "Your session ended. Sign in again.",
  // Phase 3: roles, routines, chores and holidays.
  adults_only: "Ask a parent to make this change.",
  children_can_only_tick: "You can tick this off, but only a parent can change it.",
  not_assigned_to_you: "This one is for someone else to tick off.",
  member_not_in_household: "That person isn't in this household any more. Pick someone else.",
  item_not_found: "That was deleted on another phone. Pull down to refresh.",
  zone_rotation_start_check: "The rotation has to start on a Monday.",
  day_overrides_check: "The last day can't be before the first day.",
};

export function friendlyError(error: unknown): string {
  const raw =
    typeof error === "object" && error !== null && "message" in error
      ? String((error as { message: unknown }).message)
      : String(error ?? "");
  const code = Object.keys(MESSAGES).find((key) => raw.includes(key));
  return code ? MESSAGES[code] : "Something went wrong saving that. Check your connection and try again.";
}
