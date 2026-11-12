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
};

export function friendlyError(error: unknown): string {
  const raw =
    typeof error === "object" && error !== null && "message" in error
      ? String((error as { message: unknown }).message)
      : String(error ?? "");
  const code = Object.keys(MESSAGES).find((key) => raw.includes(key));
  return code ? MESSAGES[code] : "Something went wrong saving that. Check your connection and try again.";
}
