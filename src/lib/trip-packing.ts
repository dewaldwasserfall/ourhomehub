/**
 * Packing lists for trips: pure helpers.
 *
 *   * packingTree()      – top-level items in order, each with its children
 *                          (an item is a group when something points at it)
 *   * packingProgress()  – "12 of 30 packed" (group headers don't count)
 *   * filterForPerson()  – what to show for one person, or shared items
 *   * groupToggle()      – which items to change when a group is ticked
 *   * toTemplate() / fromTemplate() – save a list, add a saved list to a trip
 */
import type { ChecklistTemplate, TripChecklistItem } from "./types";

export interface PackingNode {
  item: TripChecklistItem;
  children: TripChecklistItem[];
  /** Has children (or was made as a group and is still empty). */
  isGroup: boolean;
  /** Groups: every child done (and at least one child). */
  done: boolean;
}

const byOrder = (a: TripChecklistItem, b: TripChecklistItem) =>
  a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at);

// -----------------------------------------------------------------------------
// Step 1: the tree
// -----------------------------------------------------------------------------

export function packingTree(items: TripChecklistItem[]): PackingNode[] {
  const top = items.filter((i) => !i.parent_id).sort(byOrder);
  return top.map((item) => {
    const children = items.filter((i) => i.parent_id === item.id).sort(byOrder);
    const isGroup = children.length > 0;
    return { item, children, isGroup, done: isGroup ? children.every((c) => c.done) : item.done };
  });
}

/** Items that count: children and plain top-level items, not group headers. */
export function countable(items: TripChecklistItem[]): TripChecklistItem[] {
  const parents = new Set(items.map((i) => i.parent_id).filter(Boolean));
  return items.filter((i) => i.parent_id || !parents.has(i.id));
}

export function packingProgress(items: TripChecklistItem[]): { done: number; total: number } {
  const list = countable(items);
  return { done: list.filter((i) => i.done).length, total: list.length };
}

// -----------------------------------------------------------------------------
// Step 2: one person's view
// -----------------------------------------------------------------------------

/**
 * "everyone": all items. A member id: their items, plus groups holding any of
 * theirs (with only their children). "shared": items for nobody.
 */
export function filterForPerson(items: TripChecklistItem[], who: "everyone" | "shared" | string): TripChecklistItem[] {
  if (who === "everyone") return items;
  const wanted = (i: TripChecklistItem) => (who === "shared" ? i.member_id === null : i.member_id === who);
  const keep = new Set<string>();
  for (const i of items) {
    if (i.parent_id) {
      if (wanted(i)) {
        keep.add(i.id);
        keep.add(i.parent_id);
      }
    } else if (wanted(i)) {
      keep.add(i.id);
    }
  }
  return items.filter((i) => keep.has(i.id));
}

// -----------------------------------------------------------------------------
// Step 3: ticking a group ticks all of it
// -----------------------------------------------------------------------------

/** The ids to set to `done` when a group (or plain item) is tapped. */
export function groupToggle(node: PackingNode, visible: TripChecklistItem[]): { ids: string[]; done: boolean } {
  if (!node.isGroup) return { ids: [node.item.id], done: !node.item.done };
  // Only the children shown (in a person's view, just theirs).
  const kids = node.children.filter((c) => visible.some((v) => v.id === c.id));
  const allDone = kids.length > 0 && kids.every((c) => c.done);
  return { ids: kids.map((c) => c.id), done: !allDone };
}

// -----------------------------------------------------------------------------
// Step 4: templates
// -----------------------------------------------------------------------------

/** A trip's list as a template (done state and people dropped). */
export function toTemplate(items: TripChecklistItem[]): ChecklistTemplate["items"] {
  return packingTree(items).map((n) =>
    n.isGroup ? { text: n.item.text, children: n.children.map((c) => c.text) } : { text: n.item.text },
  );
}

/** How many items a template adds (group headers not counted). */
export const templateSize = (t: Pick<ChecklistTemplate, "items">) =>
  t.items.reduce((sum, i) => sum + (i.children?.length ? i.children.length : 1), 0);
