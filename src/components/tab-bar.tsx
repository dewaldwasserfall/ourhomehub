/**
 * Bottom tab bar: Lists, Calendar, Rhythms, Household. Frosted, fixed, safe-area aware.
 */
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { CalendarIcon, HomeIcon, ListsIcon, RhythmIcon } from "./icons";

const TABS = [
  { href: "/", label: "Lists", Icon: ListsIcon, match: (p: string) => p === "/" || p.startsWith("/lists") },
  { href: "/calendar", label: "Calendar", Icon: CalendarIcon, match: (p: string) => p.startsWith("/calendar") },
  { href: "/rhythms", label: "Rhythms", Icon: RhythmIcon, match: (p: string) => p.startsWith("/rhythms") },
  { href: "/household", label: "Household", Icon: HomeIcon, match: (p: string) => p.startsWith("/household") },
];

export function TabBar() {
  const pathname = usePathname();

  return (
    <nav className="tabbar" aria-label="Main">
      <div className="tabbar__inner">
        {TABS.map(({ href, label, Icon, match }) => (
          <Link
            key={href}
            href={href}
            className="tabbar__item"
            aria-current={match(pathname) ? "page" : undefined}
          >
            <Icon size={26} />
            {label}
          </Link>
        ))}
      </div>
    </nav>
  );
}
