/**
 * Turns what someone types into the composer into a name and a quantity.
 *
 *   "2 milk"         -> { name: "milk",        quantity: "2" }
 *   "2x milk"        -> { name: "milk",        quantity: "2" }
 *   "milk x2"        -> { name: "milk",        quantity: "2" }
 *   "500g mince"     -> { name: "mince",       quantity: "500 g" }
 *   "1.5 kg potatoes"-> { name: "potatoes",    quantity: "1.5 kg" }
 *   "Toilet paper"   -> { name: "Toilet paper", quantity: null }
 */

export interface ParsedEntry {
  name: string;
  quantity: string | null;
}

// Units we recognise straight after a number.
const UNIT = "(?:kg|g|gr|l|ml|cl|pcs|pc|st|stuks|pack|packs|bags?|bottles?|cans?|tins?|boxes|box|x)";

// Step 1: quantity at the start: "2 milk", "2x milk", "500g mince", "1,5 kg rice".
const LEADING = new RegExp(`^(\\d+(?:[.,]\\d+)?)\\s*(${UNIT})?\\s+(.+)$`, "i");

// Step 2: quantity at the end: "milk x2", "milk 2", "mince 500g".
const TRAILING = new RegExp(`^(.+?)\\s+(?:x\\s*)?(\\d+(?:[.,]\\d+)?)\\s*(${UNIT})?$`, "i");

function formatQuantity(amount: string, unit: string | undefined): string {
  const cleanAmount = amount.replace(",", ".");
  if (!unit || unit.toLowerCase() === "x") return cleanAmount;
  return `${cleanAmount} ${unit.toLowerCase()}`;
}

export function parseEntryInput(raw: string): ParsedEntry {
  const input = raw.trim().replace(/\s+/g, " ");

  // Step 3: try "quantity first", then "quantity last".
  const leading = input.match(LEADING);
  if (leading) {
    return { name: leading[3].trim(), quantity: formatQuantity(leading[1], leading[2]) };
  }

  const trailing = input.match(TRAILING);
  // Avoid eating numbers that are part of a name like "7up" or "Cola 0".
  if (trailing && trailing[2] !== "0") {
    return { name: trailing[1].trim(), quantity: formatQuantity(trailing[2], trailing[3]) };
  }

  // Step 4: no quantity found.
  return { name: input, quantity: null };
}
