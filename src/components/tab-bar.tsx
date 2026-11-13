/**
 * Bottom tab bar: Today, Lists, Calendar, Household. Frosted, fixed,
 * safe-area aware. Rhythms lives inside Lists, so its tab lights up Lists.
 */
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { CalendarIcon, HomeIcon, ListsIcon, SunIcon } from "./icons";

const TABS = [
  { href: "/", label: "Today", Icon: SunIcon, match: (p: string) => p === "/" },
  {
    href: "/lists",
    label: "Lists",
    Icon: ListsIcon,
    match: (p: string) => p.startsWith("/lists") || p.startsWith("/rhythms"),
  },
  { href: "/calendar", label: "Calendar", Icon: CalendarIcon, match: (p: string) => p.startsWith("/calendar") },
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
