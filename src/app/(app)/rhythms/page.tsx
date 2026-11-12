/**
 * Rhythms tab: what the app has learned about how often you buy things.
 *
 * "Coming up" shows items with a known rhythm, ordered by when they're due,
 * each with a bar showing how far through its usual gap you are. The notch
 * on the bar is where Hub will add it to the list.
 * "Still learning" shows items that need more history first.
 */
"use client";

import { useEffect, useMemo, useState } from "react";
import { GlowSparkle } from "@/components/icons";
import { Navbar } from "@/components/navbar";
import {
  describeAgo,
  describeDue,
  describeInterval,
  rhythmState,
  type RhythmState,
} from "@/lib/rhythm";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import type { ItemPattern } from "@/lib/types";

type PatternWithItem = ItemPattern & { item: { display_name: string; category: string } };

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Bars cover 0..1.25 of the usual gap, so overdue items visibly overshoot. */
const BAR_SPAN = 1.25;

export default function RhythmsPage() {
  const supabase = getSupabaseBrowserClient();
  const [patterns, setPatterns] = useState<PatternWithItem[] | null>(null);
  const [onList, setOnList] = useState<Set<string>>(new Set());

  // Step 1: load every learned pattern and what's currently on a list.
  useEffect(() => {
    (async () => {
      await supabase.rpc("refresh_suggestions");
      const [patternsRes, openRes] = await Promise.all([
        supabase.from("item_patterns").select("*, item:items(display_name, category)"),
        supabase.from("list_entries").select("item_id").eq("status", "open").not("item_id", "is", null),
      ]);
      setPatterns((patternsRes.data ?? []) as PatternWithItem[]);
      setOnList(new Set(((openRes.data ?? []) as Array<{ item_id: string }>).map((r) => r.item_id)));
    })();
  }, [supabase]);

  // Step 2: split into known rhythms and still-learning items.
  const { known, learning } = useMemo(() => {
    const now = new Date();
    const rows = (patterns ?? []).map((p) => ({ pattern: p, state: rhythmState(p, now) }));
    return {
      known: rows
        .filter((r): r is { pattern: PatternWithItem; state: Extract<RhythmState, { kind: "known" }> } => r.state.kind === "known")
        .sort((a, b) => a.state.nextDue.localeCompare(b.state.nextDue)),
      learning: rows
        .filter((r) => r.state.kind !== "known")
        .sort((a, b) => b.pattern.purchase_count - a.pattern.purchase_count),
    };
  }, [patterns]);

  return (
    <main className="screen">
      <Navbar title="Rhythms" />

      {/* How it works */}
      <section className="section">
        <div className="explainer">
          <GlowSparkle size={22} id="spark-explainer" />
          <span>
            <strong>Hub learns as you shop.</strong> After three shops it knows how often you buy each thing, and
            adds it to Groceries just before you usually run out.
          </span>
        </div>
      </section>

      {patterns === null && (
        <section className="section">
          <div className="group">
            {[0, 1, 2].map((i) => (
              <div key={i} className="skeleton" style={{ height: 84 }} />
            ))}
          </div>
        </section>
      )}

      {patterns?.length === 0 && (
        <section className="section">
          <div className="group empty">
            <span className="empty__title">Nothing learned yet</span>
            Tick items off a shopping list as you buy them. They&rsquo;ll show up here after the first shop.
          </div>
        </section>
      )}

      {/* Known rhythms */}
      {known.length > 0 && (
        <section className="section">
          <div className="section__header">
            <span className="section__header-title">Coming up</span>
            <span className="row__count">{known.length}</span>
          </div>
          <div className="group">
            {known.map(({ pattern, state }) => {
              const listed = onList.has(pattern.item_id);
              const isDue = new Date(state.nextDue).getTime() <= Date.now();
              const fill = Math.min(state.progress, BAR_SPAN) / BAR_SPAN;
              const notch = Number(pattern.threshold_factor) / BAR_SPAN;
              return (
                <div key={pattern.item_id} className="row rhythm-row">
                  <div className="row__body">
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
                      <span className="row__title">{pattern.item.display_name}</span>
                      <span className={`rhythm__due ${listed || isDue ? "rhythm__due--now" : ""}`} style={{ fontSize: 15 }}>
                        {listed ? "On your list" : describeDue(state.nextDue)}
                      </span>
                    </div>
                    <div
                      className="rhythm-bar"
                      role="img"
                      aria-label={`${Math.round(state.progress * 100)}% of the usual gap since last bought`}
                    >
                      <div
                        className="rhythm-bar__fill"
                        style={{ width: `${fill * 100}%`, backgroundSize: `${fill > 0 ? 100 / fill : 100}% 100%` }}
                      />
                      <div className="rhythm-bar__notch" style={{ left: `calc(${notch * 100}% - 1px)` }} />
                    </div>
                    <div className="rhythm__meta">
                      <span>{capitalise(describeInterval(state.intervalDays))}</span>
                      <span>Last bought {describeAgo(state.lastBought)}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <p className="section__footer">
            The gap in each bar marks when Hub adds the item. Saying &ldquo;Not now&rdquo; moves it later; buying it
            before then moves it earlier.
          </p>
        </section>
      )}

      {/* Still learning */}
      {learning.length > 0 && (
        <section className="section">
          <div className="section__header">
            <span className="section__header-title">Still learning</span>
            <span className="row__count">{learning.length}</span>
          </div>
          <div className="group">
            {learning.map(({ pattern, state }) => (
              <div key={pattern.item_id} className="row rhythm-row">
                <div className="row__body">
                  <span className="row__title">{pattern.item.display_name}</span>
                  <span className="row__subtitle">
                    {state.kind === "irregular"
                      ? "Bought at uneven gaps so far, so Hub won't guess yet."
                      : `Bought ${pattern.purchase_count === 1 ? "once" : `${pattern.purchase_count} times`}. Learns after 3 shops.`}
                  </span>
                </div>
                {state.kind === "learning" && (
                  <span className="learning-dots" aria-label={`${pattern.purchase_count} of 3 shops`}>
                    {[0, 1, 2].map((i) => (
                      <span key={i} className="learning-dots__dot" data-on={i < pattern.purchase_count} />
                    ))}
                  </span>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
