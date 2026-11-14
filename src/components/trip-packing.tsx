/**
 * A trip's packing list.
 *
 *   * Whose list: Everyone, one person going, or Shared (items for nobody).
 *   * "12 of 30 packed" progress.
 *   * Groups (e.g. "Car rental" with its items): ticking the group ticks
 *     everything in it (only that person's items in their view).
 *   * Add an item (text, group, who it's for); tap an item's text to edit.
 *   * Add from a saved list; save this list for next time.
 *
 * Adults with Trips access change it; children with access only look.
 */
"use client";

import { useMemo, useState } from "react";
import { Avatar } from "@/components/avatar";
import { CheckCircle } from "@/components/check-circle";
import { MemberChips } from "@/components/plan-controls";
import { Sheet } from "@/components/sheet";
import { useToast } from "@/components/toast";
import { friendlyError } from "@/lib/errors";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { filterForPerson, groupToggle, packingProgress, packingTree, templateSize, toTemplate } from "@/lib/trip-packing";
import type { Member, TripChecklistItem } from "@/lib/types";
import { useChecklistTemplates } from "@/lib/use-trips";

type Who = "everyone" | "shared" | string;
type Editing = { item: TripChecklistItem | null; parentId: string | null } | null;

export function TripPacking({
  tripId,
  householdId,
  items,
  going,
  memberById,
  canEdit,
  reload,
}: {
  tripId: string;
  householdId: string;
  items: TripChecklistItem[];
  /** People on the trip, in household order. */
  going: Member[];
  memberById: (id: string | null) => Member | undefined;
  canEdit: boolean;
  reload: () => Promise<void>;
}) {
  const supabase = getSupabaseBrowserClient();
  const toast = useToast();
  const { templates, reload: reloadTemplates } = useChecklistTemplates(householdId, true);
  const [who, setWho] = useState<Who>("everyone");
  const [editing, setEditing] = useState<Editing>(null);
  const [picking, setPicking] = useState(false);
  const [saving, setSaving] = useState(false);

  // Step 1: what to show.
  const visible = useMemo(() => filterForPerson(items, who), [items, who]);
  const tree = useMemo(() => packingTree(visible), [visible]);
  const progress = packingProgress(visible);
  const groups = useMemo(() => packingTree(items).filter((n) => n.isGroup || !n.item.parent_id), [items]);

  async function run(write: PromiseLike<{ error: { message: string } | null }>) {
    const { error } = await write;
    if (error) toast.show(friendlyError(error));
    await reload();
    return !error;
  }

  // Step 2: tick (a group ticks its visible children).
  const toggle = (node: ReturnType<typeof packingTree>[number]) => {
    if (!canEdit) return;
    const { ids, done } = groupToggle(node, visible);
    if (ids.length) run(supabase.from("trip_checklist").update({ done }).in("id", ids));
  };
  const toggleChild = (item: TripChecklistItem) => canEdit && run(supabase.from("trip_checklist").update({ done: !item.done }).eq("id", item.id));

  // Step 3: add from a saved list (after everything already there).
  async function addTemplate(templateId: string) {
    const t = templates.find((x) => x.id === templateId);
    if (!t) return;
    let order = Math.max(0, ...items.map((i) => i.sort_order)) + 1;
    for (const entry of t.items) {
      const { data, error } = await supabase
        .from("trip_checklist")
        .insert({ trip_id: tripId, text: entry.text, sort_order: order++ })
        .select("id")
        .single();
      if (error) {
        toast.show(friendlyError(error));
        break;
      }
      if (entry.children?.length) {
        await supabase.from("trip_checklist").insert(
          entry.children.map((text, i) => ({ trip_id: tripId, text, parent_id: (data as { id: string }).id, sort_order: i })),
        );
      }
    }
    setPicking(false);
    toast.show(`Added ${t.name}`);
    await reload();
  }

  async function saveTemplate(name: string) {
    const ok = await run(supabase.from("checklist_templates").insert({ household_id: householdId, name, items: toTemplate(items) }));
    if (ok) {
      toast.show(`Saved as ${name}`);
      setSaving(false);
      reloadTemplates();
    }
  }

  // Step 4: render.
  const label = (item: TripChecklistItem) => {
    const m = item.member_id ? memberById(item.member_id) : undefined;
    return (
      <span className="row__body">
        <span className={`row__title ${item.done ? "packing-done" : ""}`}>{item.text}</span>
        {m && who === "everyone" && <span className="row__subtitle">{m.display_name.split(" ")[0]}</span>}
      </span>
    );
  };

  return (
    <>
      {/* Whose list */}
      {going.length > 0 && (
        <section className="section">
          <div className="chip-grid" role="group" aria-label="Whose list">
            <button type="button" className="chip" aria-pressed={who === "everyone"} onClick={() => setWho("everyone")}>
              Everyone
            </button>
            {going.map((m) => (
              <button key={m.id} type="button" className="chip chip--person" aria-pressed={who === m.id} onClick={() => setWho(m.id)}>
                <Avatar member={m} size="mini" />
                {m.display_name.split(" ")[0]}
              </button>
            ))}
            <button type="button" className="chip" aria-pressed={who === "shared"} onClick={() => setWho("shared")}>
              Shared
            </button>
          </div>
        </section>
      )}

      <section className="section">
        <div className="section__header">
          <span className="section__header-title">
            {progress.total ? `${progress.done} of ${progress.total} packed` : "Packing"}
          </span>
        </div>
        <div className="group">
          {tree.length === 0 && (
            <div className="row">
              <span className="row__body row__subtitle">
                {items.length ? "Nothing on this list yet." : "Nothing to pack yet. Add items, or start from a saved list."}
              </span>
            </div>
          )}
          {tree.map((node) => (
            <div key={node.item.id} className={node.isGroup ? "packing-group" : undefined}>
              <div className="row">
                <CheckCircle checked={node.done} onToggle={() => toggle(node)} label={node.item.text} />
                <button
                  type="button"
                  className="packing-text"
                  onClick={canEdit ? () => setEditing({ item: node.item, parentId: null }) : undefined}
                  disabled={!canEdit}
                >
                  {label(node.item)}
                </button>
                {node.isGroup && (
                  <span className="row__trailing packing-count">
                    {node.children.filter((c) => c.done).length}/{node.children.length}
                  </span>
                )}
              </div>
              {node.children.map((c) => (
                <div key={c.id} className="row packing-child">
                  <CheckCircle checked={c.done} onToggle={() => toggleChild(c)} label={c.text} />
                  <button type="button" className="packing-text" onClick={canEdit ? () => setEditing({ item: c, parentId: c.parent_id }) : undefined} disabled={!canEdit}>
                    {label(c)}
                  </button>
                </div>
              ))}
            </div>
          ))}
          {canEdit && (
            <button
              type="button"
              className="row row--pressable trip-add-row"
              onClick={() => setEditing({ item: null, parentId: null })}
            >
              <span className="row__body">Add an item</span>
            </button>
          )}
        </div>
      </section>

      {canEdit && (
        <section className="section">
          <div className="trip-actions">
            <button type="button" className="button" onClick={() => setPicking(true)} disabled={templates.length === 0}>
              Add a saved list
            </button>
            <button type="button" className="button" onClick={() => setSaving(true)} disabled={items.length === 0}>
              Save as a list
            </button>
          </div>
          {templates.length === 0 && <p className="section__footer">Save this list once and add it to the next trip in one tap.</p>}
        </section>
      )}

      {/* Sheets */}
      <ItemSheet
        editing={editing}
        groups={groups.map((g) => g.item).filter((g) => g.id !== editing?.item?.id)}
        isGroupHeader={!!editing?.item && items.some((i) => i.parent_id === editing.item!.id)}
        going={going}
        defaultWho={who !== "everyone" && who !== "shared" ? who : null}
        onClose={() => setEditing(null)}
        onSave={async (fields) => {
          if (editing?.item) return run(supabase.from("trip_checklist").update(fields).eq("id", editing.item.id));
          const order = Math.max(0, ...items.filter((i) => i.parent_id === fields.parent_id).map((i) => i.sort_order)) + 1;
          return run(supabase.from("trip_checklist").insert({ trip_id: tripId, ...fields, sort_order: order }));
        }}
        onDelete={async () => {
          if (editing?.item && (await run(supabase.from("trip_checklist").delete().eq("id", editing.item.id)))) setEditing(null);
        }}
      />

      <Sheet
        open={picking}
        onClose={() => setPicking(false)}
        title="Add a saved list"
        leading={
          <button type="button" className="nav-button" onClick={() => setPicking(false)}>
            Cancel
          </button>
        }
      >
        <div className="sheet__stack">
          <div className="group">
            {templates.map((t) => (
              <div key={t.id} className="row">
                <button type="button" className="row__body packing-text" onClick={() => addTemplate(t.id)}>
                  <span className="row__title">{t.name}</span>
                  <span className="row__subtitle">{templateSize(t)} items</span>
                </button>
                <button
                  type="button"
                  className="chip-button"
                  onClick={async () => {
                    if (await run(supabase.from("checklist_templates").delete().eq("id", t.id))) reloadTemplates();
                  }}
                >
                  Delete
                </button>
              </div>
            ))}
          </div>
        </div>
      </Sheet>

      <NameSheet open={saving} onClose={() => setSaving(false)} onSave={saveTemplate} />
      {toast.node}
    </>
  );
}

// -----------------------------------------------------------------------------
// An item: text, which group, who it's for
// -----------------------------------------------------------------------------

function ItemSheet({
  editing,
  groups,
  isGroupHeader,
  going,
  defaultWho,
  onClose,
  onSave,
  onDelete,
}: {
  editing: Editing;
  groups: TripChecklistItem[];
  isGroupHeader: boolean;
  going: Member[];
  defaultWho: string | null;
  onClose: () => void;
  onSave: (fields: { text: string; parent_id: string | null; member_id: string | null }) => Promise<boolean>;
  onDelete: () => void;
}) {
  const [text, setText] = useState("");
  const [parent, setParent] = useState<string | null>(null);
  const [member, setMember] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [lastOpened, setLastOpened] = useState<Editing>(null);

  // Fill the fields each time the sheet opens (no effect needed).
  if (editing !== lastOpened) {
    setLastOpened(editing);
    if (editing) {
      setText(editing.item?.text ?? "");
      setParent(editing.item?.parent_id ?? editing.parentId);
      setMember(editing.item ? editing.item.member_id : defaultWho);
      setConfirm(false);
    }
  }

  const save = async (keepOpen: boolean) => {
    if (!text.trim()) return;
    setBusy(true);
    const ok = await onSave({ text: text.trim(), parent_id: isGroupHeader ? null : parent, member_id: member });
    setBusy(false);
    if (!ok) return;
    // "Add another": clear the text, keep the group and person.
    if (keepOpen) setText("");
    else onClose();
  };

  return (
    <Sheet
      open={!!editing}
      onClose={onClose}
      title={editing?.item ? "Item" : "New item"}
      leading={
        <button type="button" className="nav-button" onClick={onClose}>
          Cancel
        </button>
      }
      trailing={
        <button type="button" className="nav-button nav-button--strong" onClick={() => save(false)} disabled={busy || !text.trim()}>
          {editing?.item ? "Done" : "Add"}
        </button>
      }
    >
      <div className="sheet__stack">
        <input
          className="input"
          aria-label="Item"
          placeholder={isGroupHeader ? "Group name" : "e.g. Swimming goggles"}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !editing?.item) {
              e.preventDefault();
              save(true);
            }
          }}
          maxLength={200}
          style={{ fontWeight: 600 }}
          autoFocus={!editing?.item}
        />
        {!isGroupHeader && groups.length > 0 && (
          <div>
            <span className="field__label">In a group</span>
            <div className="chip-grid" role="group" aria-label="Group">
              <button type="button" className="chip" aria-pressed={parent === null} onClick={() => setParent(null)}>
                None
              </button>
              {groups.map((g) => (
                <button key={g.id} type="button" className="chip" aria-pressed={parent === g.id} onClick={() => setParent(g.id)}>
                  {g.text}
                </button>
              ))}
            </div>
            <p className="section__footer" style={{ margin: "6px 0 0" }}>
              Putting an item in another one turns that into a group.
            </p>
          </div>
        )}
        {going.length > 0 && <MemberChips members={going} value={member} onChange={setMember} label="For" anyoneLabel="Shared" />}
        {!editing?.item && (
          <button type="button" className="button" onClick={() => save(true)} disabled={busy || !text.trim()}>
            Add and add another
          </button>
        )}
        {editing?.item && (
          <button type="button" className="button button--danger" onClick={() => (confirm ? onDelete() : setConfirm(true))}>
            {confirm ? (isGroupHeader ? "Tap again: deletes the group and its items" : "Tap again to delete") : "Delete"}
          </button>
        )}
      </div>
    </Sheet>
  );
}

/** Name a saved list. */
function NameSheet({ open, onClose, onSave }: { open: boolean; onClose: () => void; onSave: (name: string) => void }) {
  const [name, setName] = useState("");
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Save as a list"
      leading={
        <button type="button" className="nav-button" onClick={onClose}>
          Cancel
        </button>
      }
      trailing={
        <button type="button" className="nav-button nav-button--strong" onClick={() => name.trim() && onSave(name.trim())} disabled={!name.trim()}>
          Save
        </button>
      }
    >
      <div className="sheet__stack">
        <input
          className="input"
          aria-label="List name"
          placeholder="e.g. Beach holiday"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={120}
          autoFocus
        />
        <p className="section__footer" style={{ margin: 0 }}>
          Saves the items and groups, not who they&rsquo;re for or what&rsquo;s packed.
        </p>
      </div>
    </Sheet>
  );
}
