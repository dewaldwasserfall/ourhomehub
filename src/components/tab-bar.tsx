/**
 * Bottom tab bar: Today, Lists, Calendar, (Trips, Vault,) Household.
 * Frosted, fixed, safe-area aware. Rhythms lives inside Lists, so its tab
 * lights up Lists. Trips and Vault only show for people the owner gave access.
 */
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { canSeeTrips, canSeeVault } from "@/lib/roles";
import { useHousehold } from "./household-context";
import { CalendarIcon, HomeIcon, ListsIcon, SuitcaseIcon, SunIcon, VaultIcon } from "./icons";

const TABS = [
  { href: "/", label: "Today", Icon: SunIcon, match: (p: string) => p === "/" },
  {
    href: "/lists",
    label: "Lists",
    Icon: ListsIcon,
    match: (p: string) => p.startsWith("/lists") || p.startsWith("/rhythms"),
  },
  { href: "/calendar", label: "Calendar", Icon: CalendarIcon, match: (p: string) => p.startsWith("/calendar") },
  { href: "/trips", label: "Trips", Icon: SuitcaseIcon, match: (p: string) => p.startsWith("/trips") },
  { href: "/vault", label: "Vault", Icon: VaultIcon, match: (p: string) => p.startsWith("/vault") },
  { href: "/household", label: "Household", Icon: HomeIcon, match: (p: string) => p.startsWith("/household") },
];

export function TabBar() {
  const pathname = usePathname();
  const { me } = useHousehold();
  const tabs = TABS.filter(
    (t) => (t.href !== "/trips" || canSeeTrips(me)) && (t.href !== "/vault" || canSeeVault(me)),
  );

  return (
    <nav className="tabbar" aria-label="Main">
      <div className="tabbar__inner">
        {tabs.map(({ href, label, Icon, match }) => (
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
