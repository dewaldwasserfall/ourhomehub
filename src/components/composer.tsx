/**
 * The "add" bar floating above the tab bar.
 *
 * Understands quantities ("2 milk", "milk x2", "500g mince"), suggests items
 * the household has bought before, and keeps focus after adding so a whole
 * shop can be typed in one go.
 */
"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { describeInterval } from "@/lib/rhythm";
import { parseEntryInput } from "@/lib/parse";
import type { ItemWithPattern } from "@/lib/types";
import { ArrowUpIcon, PlusIcon } from "./icons";

interface ComposerProps {
  placeholder: string;
  /** Known items for autocomplete; omit for to-do lists. */
  catalogue?: ItemWithPattern[];
  /** Item ids already open on the list (hidden from autocomplete). */
  openItemIds?: Set<string>;
  onAdd: (name: string, quantity: string | null, knownItem?: ItemWithPattern) => Promise<boolean>;
}

const MAX_SUGGESTIONS = 5;

export function Composer({ placeholder, catalogue, openItemIds, onAdd }: ComposerProps) {
  const [value, setValue] = useState("");
  const [focused, setFocused] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const parsed = useMemo(() => parseEntryInput(value), [value]);

  // Step 1: autocomplete. Prefix matches first, then word matches, then
  // anything containing the text. Items already on the list are skipped.
  const matches = useMemo(() => {
    const query = parsed.name.trim().toLowerCase();
    if (!catalogue || query.length < 1) return [];
    const scored = catalogue
      .filter((item) => !openItemIds?.has(item.id))
      .map((item) => {
        const name = item.display_name.toLowerCase();
        const score = name.startsWith(query) ? 0 : name.includes(` ${query}`) ? 1 : name.includes(query) ? 2 : -1;
        return { item, score };
      })
      .filter(({ score }) => score >= 0)
      .sort(
        (a, b) =>
          a.score - b.score ||
          (b.item.pattern?.purchase_count ?? 0) - (a.item.pattern?.purchase_count ?? 0) ||
          a.item.display_name.localeCompare(b.item.display_name),
      );
    // Hide the dropdown when the only match is exactly what was typed.
    if (scored.length === 1 && scored[0].item.display_name.toLowerCase() === query) return [];
    return scored.slice(0, MAX_SUGGESTIONS).map(({ item }) => item);
  }, [catalogue, openItemIds, parsed.name]);

  const showAutocomplete = focused && matches.length > 0;

  // Step 2: add the typed text, or the highlighted suggestion.
  async function submit(item?: ItemWithPattern) {
    const name = item ? item.display_name : parsed.name.trim();
    if (!name || busy) return;
    setBusy(true);
    const known =
      item ?? catalogue?.find((c) => c.display_name.toLowerCase() === name.toLowerCase());
    const ok = await onAdd(name, parsed.quantity, known);
    setBusy(false);
    if (ok) {
      setValue("");
      setHighlight(-1);
      inputRef.current?.focus();
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    submit(highlight >= 0 ? matches[highlight] : undefined);
  }

  // Step 3: arrow keys move through suggestions; Escape closes them.
  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (!showAutocomplete) return;
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight((h) => (h <= 0 ? matches.length - 1 : h - 1));
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlight((h) => (h >= matches.length - 1 ? 0 : h + 1));
    } else if (event.key === "Escape") {
      setHighlight(-1);
      inputRef.current?.blur();
    }
  }

  return (
    <div className="composer">
      <div className="composer__inner">
        <AnimatePresence>
          {showAutocomplete && (
            <motion.div
              className="autocomplete"
              role="listbox"
              aria-label="Bought before"
              initial={{ opacity: 0, y: 6, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 6, scale: 0.98 }}
              transition={{ duration: 0.16 }}
              style={{ transformOrigin: "bottom center" }}
            >
              {matches.map((item, i) => (
                <button
                  key={item.id}
                  type="button"
                  role="option"
                  aria-selected={i === highlight}
                  className="row row--pressable"
                  // mousedown (not click) so the input doesn't blur first.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    submit(item);
                  }}
                >
                  <span className="row__body">
                    <span className="row__title">{item.display_name}</span>
                    <span className="row__subtitle">
                      {item.pattern?.median_interval_days
                        ? `${item.category}, usually ${describeInterval(Number(item.pattern.median_interval_days))}`
                        : item.category}
                    </span>
                  </span>
                  <PlusIcon size={20} style={{ color: "var(--accent)" }} />
                </button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>

        <form className="composer__form" onSubmit={onSubmit}>
          <PlusIcon className="composer__plus" size={22} />
          <label htmlFor="composer-input" className="visually-hidden">
            {placeholder}
          </label>
          <input
            id="composer-input"
            ref={inputRef}
            className="composer__input"
            value={value}
            placeholder={placeholder}
            onChange={(e) => {
              setValue(e.target.value);
              setHighlight(-1);
            }}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={onKeyDown}
            autoComplete="off"
            autoCorrect="on"
            enterKeyHint="done"
            maxLength={200}
          />
          {parsed.quantity && value.trim() && <span className="quantity-pill">{parsed.quantity}</span>}
          <button
            type="submit"
            className="composer__send"
            aria-label="Add"
            disabled={!parsed.name.trim() || busy}
          >
            <ArrowUpIcon size={20} />
          </button>
        </form>
      </div>
    </div>
  );
}
