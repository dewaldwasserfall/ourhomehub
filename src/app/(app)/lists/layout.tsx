/**
 * Lists section layout.
 *
 * Phones: each screen on its own, as before.
 * Desktop: an open list sits beside a column of all lists, so you can jump
 * between Groceries and To-do without going back. The Lists overview page
 * itself (/lists) stays full width; it already is the list of lists.
 */
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { CartIcon, ChecklistIcon, GlowSparkle } from "@/components/icons";
import { useIsDesktop } from "@/lib/use-is-desktop";
import { useListSummaries } from "@/lib/use-list-summaries";

/** Step 1: the column of lists shown beside an open list. */
function ListsColumn({ activeId }: { activeId: string }) {
  const { lists } = useListSummaries();
  return (
    <aside className="split__nav" aria-label="Lists">
      <div className="split__nav-title">Lists</div>
      <div className="group">
        {lists === null && <div className="skeleton" />}
        {lists?.map((list) => {
          const Icon = list.type === "shopping" ? CartIcon : ChecklistIcon;
          return (
            <Link
              key={list.id}
              href={`/lists/${list.id}`}
              className="row row--link split__nav-row"
              aria-current={list.id === activeId ? "page" : undefined}
            >
              <span className="row__icon" style={{ background: list.type === "shopping" ? "var(--accent)" : "#ff9500" }}>
                <Icon size={17} strokeWidth={2} />
              </span>
              <span className="row__body">
                <span className="row__title">{list.name}</span>
              </span>
              <span className="row__trailing">
                {list.suggested > 0 && <GlowSparkle size={13} id={`nav-spark-${list.id}`} />}
                <span className="row__count">{list.open || ""}</span>
              </span>
            </Link>
          );
        })}
      </div>
    </aside>
  );
}

export default function ListsLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const isDesktop = useIsDesktop();

  // Step 2: only an open list on a wide screen gets the side column.
  const activeId = pathname.match(/^\/lists\/([^/]+)/)?.[1];
  if (!isDesktop || !activeId) return <>{children}</>;

  return (
    <div className="split">
      <ListsColumn activeId={activeId} />
      <div className="split__main">{children}</div>
    </div>
  );
}
