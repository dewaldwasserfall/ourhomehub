/**
 * Desktop sidebar: replaces the bottom tab bar on wide screens.
 *
 *   * the household's name
 *   * the four main sections (same as the tab bar)
 *   * Plan shortcuts for adults (routines, zones, chores, school holidays)
 *   * who is signed in
 *
 * Hidden below the desktop breakpoint by CSS (section 17), so phones and
 * tablets keep the tab bar exactly as before.
 */
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Avatar } from "./avatar";
import { useHousehold } from "./household-context";
import {
  BinIcon,
  CalendarIcon,
  ChoreIcon,
  HolidayIcon,
  HomeIcon,
  ListsIcon,
  ReviewIcon,
  RhythmIcon,
  RoutineIcon,
  StarIcon,
  SunIcon,
  WalletIcon,
  ZoneIcon,
} from "./icons";
import { canSeeFinances, roleLabel } from "@/lib/roles";

const STARS = { href: "/stars", label: "Stars" };

const MAIN = [
  { href: "/", label: "Today", Icon: SunIcon, match: (p: string) => p === "/" },
  { href: "/lists", label: "Lists", Icon: ListsIcon, match: (p: string) => p.startsWith("/lists") },
  { href: "/rhythms", label: "Rhythms", Icon: RhythmIcon, match: (p: string) => p.startsWith("/rhythms") },
  { href: "/calendar", label: "Calendar", Icon: CalendarIcon, match: (p: string) => p.startsWith("/calendar") },
  { href: "/household", label: "Household", Icon: HomeIcon, match: (p: string) => p === "/household" },
];

const PLAN = [
  { href: "/household/routines", label: "Routines", Icon: RoutineIcon },
  { href: "/household/zones", label: "Zones", Icon: ZoneIcon },
  { href: "/household/chores", label: "Chores", Icon: ChoreIcon },
  { href: "/household/bins", label: "Bin days", Icon: BinIcon },
  { href: "/household/holidays", label: "School holidays", Icon: HolidayIcon },
];

export function Sidebar() {
  const pathname = usePathname();
  const { household, me, meIsAdult, members } = useHousehold();

  // Step 1: one nav link, highlighted when its section is open.
  const link = (href: string, label: string, Icon: typeof SunIcon, active: boolean) => (
    <Link key={href} href={href} className="sidebar__link" aria-current={active ? "page" : undefined}>
      <Icon size={20} />
      {label}
    </Link>
  );

  return (
    <nav className="sidebar" aria-label="Main">
      {/* Step 2: the household */}
      <div className="sidebar__brand">
        <span className="sidebar__mark" aria-hidden="true">
          <HomeIcon size={18} strokeWidth={2} />
        </span>
        <span className="sidebar__household">{household.name}</span>
      </div>

      {/* Step 3: main sections */}
      <div className="sidebar__group">{MAIN.map(({ href, label, Icon, match }) => link(href, label, Icon, match(pathname)))}</div>

      {/* Step 3a: week review (adults) */}
      {meIsAdult && (
        <div className="sidebar__group">{link("/review", "Week review", ReviewIcon, pathname.startsWith("/review"))}</div>
      )}

      {/* Step 3b: stars (when the household has children) */}
      {members.some((m) => m.role === "child") && (
        <div className="sidebar__group">{link(STARS.href, STARS.label, StarIcon, pathname.startsWith("/stars"))}</div>
      )}

      {/* Step 3c: money (only for those the owner gave access) */}
      {canSeeFinances(me) && (
        <div className="sidebar__group">
          {link("/budget", "Groceries budget", WalletIcon, pathname.startsWith("/budget"))}
        </div>
      )}

      {/* Step 4: the plan (adults only, like the Household tab) */}
      {meIsAdult && (
        <div className="sidebar__group">
          <span className="sidebar__heading">Plan</span>
          {PLAN.map(({ href, label, Icon }) => link(href, label, Icon, pathname.startsWith(href)))}
        </div>
      )}

      {/* Step 5: who is signed in */}
      <Link href="/household" className="sidebar__me">
        <Avatar member={me} />
        <span className="sidebar__me-text">
          <span className="sidebar__me-name">{me.display_name}</span>
          <span className="sidebar__me-role">{roleLabel(me.role)}</span>
        </span>
      </Link>
    </nav>
  );
}
