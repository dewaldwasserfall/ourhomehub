/**
 * Bin collection days: the bin types and the "what's going out" rules, as
 * pure functions shared by Today, the Bin days screen and notifications.
 */
import { addDays } from "./calendar/time";

export type BinKind = "gft" | "plastic" | "paper" | "rest" | "glass" | "textile";

export interface BinDay {
  id: string;
  household_id: string;
  kind: BinKind;
  date: string;
}

/** Labels and colours (roughly the colours of the bins themselves). */
export const BIN_KINDS: Array<{ id: BinKind; label: string; colour: string }> = [
  { id: "plastic", label: "Plastic", colour: "#f2a900" },
  { id: "gft", label: "GFT", colour: "#2f9e44" },
  { id: "paper", label: "Paper", colour: "#1c7ed6" },
  { id: "rest", label: "Rest", colour: "#6c757d" },
  { id: "glass", label: "Glass", colour: "#0ca678" },
  { id: "textile", label: "Textile", colour: "#ae3ec9" },
];

export function binLabel(kind: BinKind): string {
  return BIN_KINDS.find((k) => k.id === kind)?.label ?? kind;
}

export function binColour(kind: BinKind): string {
  return BIN_KINDS.find((k) => k.id === kind)?.colour ?? "#868e96";
}

/** "Plastic", "Plastic and GFT", "Plastic, GFT and Paper". */
export function binList(kinds: BinKind[]): string {
  const labels = kinds.map(binLabel);
  if (labels.length <= 1) return labels.join("");
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

/** What's collected today, and what goes out tonight for tomorrow. */
export function binsAround(days: BinDay[], today: string): { today: BinKind[]; tomorrow: BinKind[] } {
  const tomorrow = addDays(today, 1);
  const kindsOn = (date: string) => BIN_KINDS.map((k) => k.id).filter((id) => days.some((d) => d.date === date && d.kind === id));
  return { today: kindsOn(today), tomorrow: kindsOn(tomorrow) };
}

/** The last date entered, so the screen can say how far ahead dates go. */
export function lastBinDate(days: BinDay[]): string | null {
  return days.reduce<string | null>((last, d) => (!last || d.date > last ? d.date : last), null);
}
