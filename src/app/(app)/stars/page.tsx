/**
 * Stars: each child's stars, streak and rewards.
 *
 *   * children see their own card and the rewards they can save for
 *   * adults see every child, add rewards, and mark a reward as given (which
 *     spends its stars)
 */
"use client";

import { useState } from "react";
import { Avatar } from "@/components/avatar";
import { useHousehold } from "@/components/household-context";
import { PlusIcon, StarIcon } from "@/components/icons";
import { Navbar } from "@/components/navbar";
import { Sheet } from "@/components/sheet";
import { StarCard } from "@/components/star-card";
import { useToast } from "@/components/toast";
import { dateKey } from "@/lib/calendar/time";
import { friendlyError } from "@/lib/errors";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { useStars, type Reward } from "@/lib/use-stars";

export default function StarsPage() {
  const supabase = getSupabaseBrowserClient();
  const { household, members, me, meIsAdult } = useHousehold();
  const today = dateKey(new Date(), household.timezone);
  const kids = members.filter((m) => m.role === "child" && (meIsAdult || m.id === me.id));
  const { stats, rewards, reload } = useStars(kids.map((k) => k.id), today);
  const toast = useToast();

  // Step 1: the add-reward sheet (adults).
  const [addingFor, setAddingFor] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [needed, setNeeded] = useState("15");

  async function addReward() {
    if (!addingFor || !title.trim()) return;
    const { error } = await supabase.from("rewards").insert({
      household_id: household.id,
      member_id: addingFor,
      title: title.trim(),
      stars_needed: Math.max(1, Math.min(1000, parseInt(needed, 10) || 1)),
    });
    if (error) return void toast.show(friendlyError(error));
    setAddingFor(null);
    setTitle("");
    setNeeded("15");
    await reload();
  }

  // Step 2: give a reward (spends the stars) or delete one not given yet.
  const [confirm, setConfirm] = useState<string | null>(null);
  async function give(reward: Reward) {
    if (confirm !== `give:${reward.id}`) return setConfirm(`give:${reward.id}`);
    const { error } = await supabase.from("rewards").update({ given_at: new Date().toISOString() }).eq("id", reward.id);
    setConfirm(null);
    if (error) return void toast.show(friendlyError(error));
    toast.show(`Given: ${reward.title}`);
    await reload();
  }
  async function remove(reward: Reward) {
    if (confirm !== `delete:${reward.id}`) return setConfirm(`delete:${reward.id}`);
    const { error } = await supabase.from("rewards").delete().eq("id", reward.id);
    setConfirm(null);
    if (error) return void toast.show(friendlyError(error));
    await reload();
  }

  return (
    <main className="screen">
      <Navbar title="Stars" subtitle="One star for every routine step, chore, zone task or to-do ticked off" />

      {kids.length === 0 && (
        <section className="section">
          <div className="group empty">
            <span className="empty__title">No children in the household</span>
            Stars are for children&rsquo;s accounts.
          </div>
        </section>
      )}

      {kids.map((kid) => {
        const balance = stats[kid.id]?.balance ?? 0;
        const open = rewards.filter((r) => r.member_id === kid.id && !r.given_at);
        const given = rewards.filter((r) => r.member_id === kid.id && r.given_at).slice(-3);
        const next = open[0];
        return (
          <section key={kid.id} className="section">
            <div className="section__header">
              <span className="section__header-title star-kid">
                <Avatar member={kid} size="mini" />
                {kid.display_name}
              </span>
              {meIsAdult && (
                <button type="button" className="section__header-action" onClick={() => setAddingFor(kid.id)}>
                  Add reward
                </button>
              )}
            </div>
            <div className="group">
              <StarCard stats={stats[kid.id]} next={next} />
            </div>

            {/* Step 3: the rewards they can save for */}
            {open.length > 0 && (
              <div className="group" style={{ marginTop: 12 }}>
                {open.map((r) => {
                  const ready = balance >= r.stars_needed;
                  return (
                    <div key={r.id} className="row">
                      <StarIcon size={20} strokeWidth={2} className={ready ? "star-card__star" : ""} style={ready ? undefined : { color: "var(--ink-3)" }} />
                      <span className="row__body">
                        <span className="row__title">{r.title}</span>
                        <span className="row__subtitle">
                          {r.stars_needed} stars{ready ? " · ready!" : ` · ${r.stars_needed - balance} to go`}
                        </span>
                      </span>
                      {meIsAdult && (
                        <span className="row__trailing">
                          {ready && (
                            <button type="button" className="chip-button" onClick={() => give(r)}>
                              {confirm === `give:${r.id}` ? "Tap to confirm" : "Give"}
                            </button>
                          )}
                          <button type="button" className="chip-button" onClick={() => remove(r)} aria-label={`Delete ${r.title}`}>
                            {confirm === `delete:${r.id}` ? "Delete?" : "×"}
                          </button>
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            {given.length > 0 && (
              <p className="section__footer">Recently given: {given.map((r) => r.title).join(", ")}</p>
            )}
          </section>
        );
      })}

      <Sheet
        open={!!addingFor}
        onClose={() => setAddingFor(null)}
        title="New reward"
        leading={
          <button type="button" className="nav-button" onClick={() => setAddingFor(null)}>
            Cancel
          </button>
        }
        trailing={
          <button type="button" className="nav-button nav-button--strong" onClick={addReward} disabled={!title.trim()}>
            Add
          </button>
        }
      >
        <div className="sheet__stack">
          <input
            className="input"
            aria-label="Reward"
            placeholder="e.g. Choose Friday's dinner"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={80}
            autoFocus
          />
          <div className="group">
            <label className="form-row">
              <span className="form-row__label">Stars needed</span>
              <input
                type="number"
                inputMode="numeric"
                className="pill-input"
                style={{ width: 80, textAlign: "center" }}
                min={1}
                max={1000}
                value={needed}
                onChange={(e) => setNeeded(e.target.value)}
              />
            </label>
          </div>
          <p className="section__footer" style={{ padding: 0 }}>
            <PlusIcon size={12} style={{ verticalAlign: "-1px" }} /> A child gets one star for each thing they tick off themselves.
          </p>
        </div>
      </Sheet>
      {toast.node}
    </main>
  );
}
