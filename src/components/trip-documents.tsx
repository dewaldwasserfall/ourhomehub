/**
 * A trip's documents (adults with Trips access only): tickets, bookings,
 * insurance, visas.
 *
 *   * Upload one or more files from the phone or Mac (25 MB each). They go
 *     to the private trip-documents bucket under <household>/<trip>/.
 *   * Tap to open: the app asks for a link that works for 5 minutes, so a
 *     copied link soon stops working.
 *   * Edit name, category and expiry date (visas); delete removes the file
 *     too.
 */
"use client";

import { useRef, useState } from "react";
import { Sheet } from "@/components/sheet";
import { useToast } from "@/components/toast";
import { friendlyError } from "@/lib/errors";
import { expiryText } from "@/lib/member-ids";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { DOCUMENT_CATEGORIES, type DocumentCategory, type TripDocument } from "@/lib/types";

const BUCKET = "trip-documents";
const MAX_BYTES = 25 * 1024 * 1024;

/** A best guess at the category from the file name. */
function guessCategory(name: string): DocumentCategory {
  const n = name.toLowerCase();
  if (/(boarding|flight|klm|transavia|ryanair|easyjet|vueling|e-?ticket)/.test(n)) return "Flight";
  if (/(hotel|booking\.com|airbnb|apartment|villa|reservation)/.test(n)) return "Hotel";
  if (/(insur|verzeker|polis)/.test(n)) return "Insurance";
  if (/(visa|esta|eta\b)/.test(n)) return "Visa";
  if (/(ticket|entry|admission|museum|park)/.test(n)) return "Ticket";
  return "Other";
}

const sizeText = (bytes: number) => (bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

export function TripDocuments({
  tripId,
  householdId,
  meId,
  documents,
  reload,
}: {
  tripId: string;
  householdId: string;
  meId: string;
  documents: TripDocument[];
  reload: () => Promise<void>;
}) {
  const supabase = getSupabaseBrowserClient();
  const toast = useToast();
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(0);
  const [editing, setEditing] = useState<TripDocument | null>(null);

  // Step 1: upload each picked file, then record it.
  async function upload(files: FileList | null) {
    if (!files?.length) return;
    const list = [...files];
    setUploading(list.length);
    for (const file of list) {
      if (file.size > MAX_BYTES) {
        toast.show(`${file.name} is over 25 MB`);
        setUploading((n) => n - 1);
        continue;
      }
      const ext = (file.name.match(/\.([a-z0-9]{1,8})$/i)?.[1] ?? "bin").toLowerCase();
      const path = `${householdId}/${tripId}/${crypto.randomUUID()}.${ext}`;
      const { error: upError } = await supabase.storage.from(BUCKET).upload(path, file, {
        contentType: file.type || "application/octet-stream",
        upsert: false,
      });
      if (upError) {
        toast.show(upError.message.includes("mime") ? `${file.name}: that kind of file can't be added` : friendlyError(upError));
        setUploading((n) => n - 1);
        continue;
      }
      const { error } = await supabase.from("trip_documents").insert({
        trip_id: tripId,
        name: file.name.replace(/\.[^.]+$/, "").slice(0, 200) || "Document",
        category: guessCategory(file.name),
        storage_path: path,
        content_type: file.type || "application/octet-stream",
        size_bytes: file.size,
        created_by: meId,
      });
      // Couldn't record it: don't leave the file behind.
      if (error) {
        await supabase.storage.from(BUCKET).remove([path]);
        toast.show(friendlyError(error));
      }
      setUploading((n) => n - 1);
    }
    if (fileInput.current) fileInput.current.value = "";
    await reload();
  }

  // Step 2: open through a 5-minute link.
  async function open(doc: TripDocument) {
    // Open the tab first (iOS blocks pop-ups opened after an await).
    const tab = window.open("", "_blank");
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(doc.storage_path, 300);
    if (error || !data) {
      tab?.close();
      return void toast.show("Couldn't open the document");
    }
    if (tab) tab.location.href = data.signedUrl;
    else window.location.href = data.signedUrl;
  }

  // Step 3: edit and delete.
  async function save(fields: Pick<TripDocument, "name" | "category" | "expiry_date">) {
    if (!editing) return false;
    const { error } = await supabase.from("trip_documents").update(fields).eq("id", editing.id);
    if (error) {
      toast.show(friendlyError(error));
      return false;
    }
    await reload();
    return true;
  }
  async function remove() {
    if (!editing) return;
    await supabase.storage.from(BUCKET).remove([editing.storage_path]);
    const { error } = await supabase.from("trip_documents").delete().eq("id", editing.id);
    if (error) return void toast.show(friendlyError(error));
    setEditing(null);
    await reload();
  }

  // Step 4: render, grouped by category.
  const groups = DOCUMENT_CATEGORIES.map((c) => [c, documents.filter((d) => d.category === c)] as const).filter(([, l]) => l.length);

  return (
    <>
      {groups.length === 0 && (
        <section className="section">
          <div className="group empty">
            <span className="empty__title">No documents yet</span>
            Boarding passes, booking confirmations, tickets and insurance, all in one place for the trip.
          </div>
        </section>
      )}

      {groups.map(([category, list]) => (
        <section key={category} className="section">
          <div className="section__header">
            <span className="section__header-title">{category}</span>
          </div>
          <div className="group">
            {list.map((d) => (
              <div key={d.id} className="row">
                <button type="button" className="packing-text" onClick={() => open(d)}>
                  <span className="row__body">
                    <span className="row__title">{d.name}</span>
                    <span className="row__subtitle">
                      {sizeText(d.size_bytes)}
                      {d.expiry_date && ` · valid until ${expiryText(d.expiry_date)}`}
                    </span>
                  </span>
                </button>
                <button type="button" className="chip-button" onClick={() => setEditing(d)}>
                  Edit
                </button>
              </div>
            ))}
          </div>
        </section>
      ))}

      <section className="section">
        <input
          ref={fileInput}
          type="file"
          multiple
          accept="application/pdf,image/*,.pkpass,text/plain"
          hidden
          onChange={(e) => upload(e.target.files)}
        />
        <button type="button" className="button button--primary" style={{ width: "100%" }} onClick={() => fileInput.current?.click()} disabled={uploading > 0}>
          {uploading > 0 ? `Uploading ${uploading}…` : "Add documents"}
        </button>
        <p className="section__footer">
          Private to you and whoever else can see Trips. Opening one makes a link that stops working after 5 minutes.
        </p>
      </section>

      <EditSheet doc={editing} onClose={() => setEditing(null)} onSave={save} onDelete={remove} />
      {toast.node}
    </>
  );
}

function EditSheet({
  doc,
  onClose,
  onSave,
  onDelete,
}: {
  doc: TripDocument | null;
  onClose: () => void;
  onSave: (fields: Pick<TripDocument, "name" | "category" | "expiry_date">) => Promise<boolean>;
  onDelete: () => void;
}) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState<DocumentCategory>("Other");
  const [expiry, setExpiry] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [last, setLast] = useState<TripDocument | null>(null);
  if (doc !== last) {
    setLast(doc);
    if (doc) {
      setName(doc.name);
      setCategory(doc.category);
      setExpiry(doc.expiry_date ?? "");
      setConfirm(false);
    }
  }
  const save = async () => {
    if (name.trim() && (await onSave({ name: name.trim(), category, expiry_date: expiry || null }))) onClose();
  };

  return (
    <Sheet
      open={!!doc}
      onClose={onClose}
      title="Document"
      leading={
        <button type="button" className="nav-button" onClick={onClose}>
          Cancel
        </button>
      }
      trailing={
        <button type="button" className="nav-button nav-button--strong" onClick={save} disabled={!name.trim()}>
          Done
        </button>
      }
    >
      <div className="sheet__stack">
        <input className="input" aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} style={{ fontWeight: 600 }} />
        <div>
          <span className="field__label">Kind</span>
          <div className="chip-grid" role="group" aria-label="Kind">
            {DOCUMENT_CATEGORIES.map((c) => (
              <button key={c} type="button" className="chip" aria-pressed={category === c} onClick={() => setCategory(c)}>
                {c}
              </button>
            ))}
          </div>
        </div>
        <div className="group">
          <label className="form-row">
            <span className="form-row__label">Valid until</span>
            <span className="form-row__controls">
              <input type="date" className="pill-input" style={{ width: 150 }} value={expiry} onChange={(e) => setExpiry(e.target.value)} />
              {expiry && (
                <button type="button" className="chip-button" onClick={() => setExpiry("")}>
                  Clear
                </button>
              )}
            </span>
          </label>
        </div>
        <button type="button" className="button button--danger" onClick={() => (confirm ? onDelete() : setConfirm(true))}>
          {confirm ? "Tap again to delete" : "Delete document"}
        </button>
      </div>
    </Sheet>
  );
}
