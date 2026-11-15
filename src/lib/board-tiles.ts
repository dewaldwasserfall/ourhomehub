/**
 * Family board: data for the left-column tiles and their full-screen views.
 *
 *   * Groceries: the open items on the shopping lists, the default list
 *     first, each list in shop order (by category, as on a phone).
 *   * Bins: the next collections, one line per day.
 */
import { categoryRank } from "./categories";
import type { BinDay } from "./bins";

export interface GroceryList {
  id: string;
  name: string;
  is_default: boolean;
  sort_order: number;
}

export interface GroceryEntry {
  id: string;
  list_id: string;
  text: string;
  quantity: string | null;
  category: string;
}

export interface GrocerySection {
  list: GroceryList;
  count: number;
  categories: { name: string; items: GroceryEntry[] }[];
}

/** Step 1: every shopping list with its open items, grouped by category. */
export function grocerySections(lists: GroceryList[], entries: GroceryEntry[]): GrocerySection[] {
  const ordered = [...lists].sort((a, b) => Number(b.is_default) - Number(a.is_default) || a.sort_order - b.sort_order);
  return ordered.map((list) => {
    const mine = entries.filter((e) => e.list_id === list.id);
    const byCategory = new Map<string, GroceryEntry[]>();
    for (const e of mine) byCategory.set(e.category, [...(byCategory.get(e.category) ?? []), e]);
    const categories = [...byCategory.entries()]
      .sort(([a], [b]) => categoryRank(a) - categoryRank(b) || a.localeCompare(b))
      .map(([name, items]) => ({ name, items: [...items].sort((x, y) => x.text.localeCompare(y.text)) }));
    return { list, count: mine.length, categories };
  });
}

/** Step 2: the tile's short preview: the first few items, and how many more. */
export function groceryPreview(section: GrocerySection | undefined, max = 6): { items: GroceryEntry[]; more: number } {
  const all = section ? section.categories.flatMap((c) => c.items) : [];
  return { items: all.slice(0, max), more: Math.max(0, all.length - max) };
}

/** "2 L milk": quantity first when there is one. */
export const groceryLabel = (e: Pick<GroceryEntry, "text" | "quantity">) => (e.quantity ? `${e.quantity} ${e.text}` : e.text);

/** Step 3: upcoming bin collections from a day on, grouped by date. */
export function upcomingBins(days: BinDay[], from: string, max = 8): { date: string; kinds: BinDay["kind"][] }[] {
  const byDate = new Map<string, BinDay["kind"][]>();
  for (const d of days) if (d.date >= from) byDate.set(d.date, [...(byDate.get(d.date) ?? []), d.kind]);
  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, max)
    .map(([date, kinds]) => ({ date, kinds }));
}
