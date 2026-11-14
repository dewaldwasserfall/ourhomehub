/**
 * Vault: passports and ID cards (its own tab; grown-ups with Trips access,
 * the same rule as the member_ids policy).
 *
 * HomeHub keeps what's on the document's info page except the number:
 * which document, issuing country, name as printed, issue date and place,
 * expiry date, and a link to the item in 1Password. The number and scan
 * stay in 1Password: "Open in 1Password" goes straight to them.
 *
 * Expiry warnings: red when expired, orange within 6 months. Reminders go
 * out 6, 3 and 1 month before (notification settings).
 */
"use client";

import { useState } from "react";
import { Avatar } from "@/components/avatar";
import { useHousehold } from "@/components/household-context";
import { PlusIcon } from "@/components/icons";
import { Navbar } from "@/components/navbar";
import { Segmented } from "@/components/segmented";
import { Sheet } from "@/components/sheet";
import { useToast } from "@/components/toast";
import { dateKey } from "@/lib/calendar/time";
import { friendlyError } from "@/lib/errors";
import { expiryStatus, expiryText, idLabel } from "@/lib/member-ids";
import { canSeeVault } from "@/lib/roles";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import type { MemberId } from "@/lib/types";
import { useMemberIds } from "@/lib/use-trips";

type Editing = { id: MemberId | null; memberId: string } | null;

/** Everything the sheet edits (all of member_ids except keys and timestamps). */
type IdFields = Pick<MemberId, "kind" | "country" | "expiry_date" | "onepassword_url" | "holder_name" | "issue_date" | "place_of_issue">;

export default function IdsPage() {
  const supabase = getSupabaseBrowserClient();
  const toast = useToast();
  const { household, members, me } = useHousehold();
  const today = dateKey(new Date(), household.timezone);
  const allowed = canSeeVault(me);
  const { ids, reload } = useMemberIds(household.id, allowed);
  const [editing, setEditing] = useState<Editing>(null);

  if (!allowed) {
    return (
      <main className="screen">
        <Navbar title="Vault" />
        <section className="section">
          <div className="group empty">
            <span className="empty__title">Private</span>
            Only grown-ups the owner gave access can see this.
          </div>
        </section>
      </main>
    );
  }

  async function save(fields: IdFields) {
    if (!editing) return false;
    const { error } = editing.id
      ? await supabase.from("member_ids").update(fields).eq("id", editing.id.id)
      : await supabase.from("member_ids").insert({ member_id: editing.memberId, ...fields });
    if (error) {
      // Step: turn the two check constraints into plain-language messages.
      toast.show(
        error.message.includes("onepassword_url")
          ? "The 1Password link should start with https:// or onepassword://"
          : error.message.includes("issue_before_expiry")
            ? "The issue date should be before the expiry date"
            : friendlyError(error),
      );
      return false;
    }
    await reload();
    return true;
  }
  async function remove() {
    if (!editing?.id) return;
    const { error } = await supabase.from("member_ids").delete().eq("id", editing.id.id);
    if (error) return void toast.show(friendlyError(error));
    setEditing(null);
    await reload();
  }

  return (
    <main className="screen">
      <Navbar title="Vault" />

      {members.map((m) => {
        const theirs = ids.filter((i) => i.member_id === m.id);
        return (
          <section key={m.id} className="section">
            <div className="section__header id-person">
              <Avatar member={m} size="mini" />
              <span className="section__header-title">{m.display_name}</span>
            </div>
            <div className="group">
              {theirs.map((i) => {
                const status = expiryStatus(i, today);
                return (
                  <div key={i.id} className="row">
                    <button type="button" className="packing-text" onClick={() => setEditing({ id: i, memberId: m.id })}>
                      <span className="row__body">
                        <span className="row__title">{idLabel(i)}</span>
                        <span className={`row__subtitle id-expiry id-expiry--${status.state}`}>
                          {status.state === "expired" ? "Expired " : "Valid until "}
                          {expiryText(i.expiry_date)}
                        </span>
                        {/* Step: name as printed, plus where and when it was issued, if known. */}
                        {(i.holder_name || i.issue_date || i.place_of_issue) && (
                          <span className="row__subtitle">
                            {[
                              i.holder_name,
                              i.issue_date || i.place_of_issue
                                ? `Issued${i.issue_date ? ` ${expiryText(i.issue_date)}` : ""}${i.place_of_issue ? ` in ${i.place_of_issue}` : ""}`
                                : "",
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </span>
                        )}
                      </span>
                    </button>
                    {i.onepassword_url && (
                      <a className="chip-button" href={i.onepassword_url} target="_blank" rel="noreferrer">
                        Open in 1Password
                      </a>
                    )}
                  </div>
                );
              })}
              <button type="button" className="row row--pressable trip-add-row" onClick={() => setEditing({ id: null, memberId: m.id })}>
                <PlusIcon size={18} />
                <span className="row__body">Add passport or ID card</span>
              </button>
            </div>
          </section>
        );
      })}

      <section className="section">
        <p className="section__footer">
          Numbers and scans stay in 1Password. In 1Password, open the item, choose Share or Copy link, and paste it here.
        </p>
      </section>

      <IdSheet editing={editing} name={members.find((m) => m.id === editing?.memberId)?.display_name ?? ""} onClose={() => setEditing(null)} onSave={save} onDelete={remove} />
      {toast.node}
    </main>
  );
}

function IdSheet({
  editing,
  name,
  onClose,
  onSave,
  onDelete,
}: {
  editing: Editing;
  name: string;
  onClose: () => void;
  onSave: (fields: IdFields) => Promise<boolean>;
  onDelete: () => void;
}) {
  const [kind, setKind] = useState<MemberId["kind"]>("passport");
  const [country, setCountry] = useState("");
  const [expiry, setExpiry] = useState("");
  const [link, setLink] = useState("");
  const [holder, setHolder] = useState("");
  const [issued, setIssued] = useState("");
  const [place, setPlace] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [last, setLast] = useState<Editing>(null);
  if (editing !== last) {
    setLast(editing);
    if (editing) {
      setKind(editing.id?.kind ?? "passport");
      setCountry(editing.id?.country ?? "");
      setExpiry(editing.id?.expiry_date ?? "");
      setLink(editing.id?.onepassword_url ?? "");
      setHolder(editing.id?.holder_name ?? "");
      setIssued(editing.id?.issue_date ?? "");
      setPlace(editing.id?.place_of_issue ?? "");
      setConfirm(false);
    }
  }
  const linkOk = !link.trim() || /^(https:\/\/|onepassword:\/\/)/.test(link.trim());
  // Step: an issue date must come before the expiry date (the database checks too).
  const datesOk = !issued || !expiry || issued < expiry;
  const valid = Boolean(expiry) && linkOk && datesOk;
  const save = async () => {
    if (valid && (await onSave({
        kind,
        country: country.trim(),
        expiry_date: expiry,
        onepassword_url: link.trim() || null,
        holder_name: holder.trim(),
        issue_date: issued || null,
        place_of_issue: place.trim(),
      }))) onClose();
  };

  return (
    <Sheet
      open={!!editing}
      onClose={onClose}
      title={name.split(" ")[0] || "Document"}
      leading={
        <button type="button" className="nav-button" onClick={onClose}>
          Cancel
        </button>
      }
      trailing={
        <button type="button" className="nav-button nav-button--strong" onClick={save} disabled={!valid}>
          {editing?.id ? "Done" : "Add"}
        </button>
      }
    >
      <div className="sheet__stack">
        <Segmented
          label="Document"
          value={kind}
          onChange={setKind}
          options={[
            { value: "passport", label: "Passport" },
            { value: "id_card", label: "ID card" },
          ]}
        />
        <input
          className="input"
          aria-label="Issuing country"
          placeholder="Issuing country, e.g. Netherlands"
          value={country}
          onChange={(e) => setCountry(e.target.value)}
          maxLength={80}
        />
        <input
          className="input"
          aria-label="Name on document"
          placeholder="Full name as printed"
          value={holder}
          onChange={(e) => setHolder(e.target.value)}
          maxLength={120}
          autoCapitalize="words"
        />
        <div className="group">
          <label className="form-row">
            <span className="form-row__label">Issued</span>
            <input type="date" className="pill-input" style={{ width: 150 }} value={issued} onChange={(e) => setIssued(e.target.value)} />
          </label>
          <label className="form-row">
            <span className="form-row__label">Valid until</span>
            <input type="date" className="pill-input" style={{ width: 150 }} value={expiry} onChange={(e) => setExpiry(e.target.value)} />
          </label>
        </div>
        {!datesOk && (
          <p className="form-error" role="alert" style={{ margin: 0 }}>
            The issue date should be before the expiry date.
          </p>
        )}
        <input
          className="input"
          aria-label="Place of issue"
          placeholder="Place of issue (optional)"
          value={place}
          onChange={(e) => setPlace(e.target.value)}
          maxLength={80}
        />
        <div>
          <span className="field__label">1Password link</span>
          <input
            className="input"
            aria-label="1Password link"
            placeholder="https://start.1password.com/open/…"
            value={link}
            onChange={(e) => setLink(e.target.value)}
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
          />
          {!linkOk && (
            <p className="form-error" role="alert" style={{ margin: "6px 0 0" }}>
              Paste the link from 1Password; it starts with https:// or onepassword://
            </p>
          )}
        </div>
        <p className="section__footer" style={{ margin: 0 }}>
          Don&rsquo;t put the document number here; it belongs in 1Password.
        </p>
        {editing?.id && (
          <button type="button" className="button button--danger" onClick={() => (confirm ? onDelete() : setConfirm(true))}>
            {confirm ? "Tap again to delete" : "Delete"}
          </button>
        )}
      </div>
    </Sheet>
  );
}
