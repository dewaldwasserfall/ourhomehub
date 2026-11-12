/**
 * Member avatar: Google photo when available, otherwise the first initial.
 */
import type { Member } from "@/lib/types";

export function Avatar({ member, size = "md" }: { member: Member | undefined; size?: "md" | "mini" }) {
  const className = size === "mini" ? "mini-avatar" : "avatar";
  if (!member) return null;

  if (member.avatar_url) {
    return (
      // Plain <img>: Google avatars are tiny and already sized by the URL.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        className={className}
        src={member.avatar_url}
        alt=""
        referrerPolicy="no-referrer"
        title={member.display_name}
      />
    );
  }
  return (
    <span className={className} title={member.display_name} aria-hidden="true">
      {member.display_name.slice(0, 1).toUpperCase()}
    </span>
  );
}
