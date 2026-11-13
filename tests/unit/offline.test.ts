/**
 * Unit tests for offline mode's local copies and outbox (with a fake
 * localStorage and window, since tests run in Node).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { clearOfflineData, enqueue, isNetworkError, pendingCount, readCache, writeCache } from "@/lib/offline";

class MemoryStorage {
  private store = new Map<string, string>();
  getItem(k: string) {
    return this.store.has(k) ? this.store.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.store.set(k, v);
  }
  removeItem(k: string) {
    this.store.delete(k);
  }
  keys() {
    return [...this.store.keys()];
  }
}

beforeEach(() => {
  const storage = new MemoryStorage();
  // Object.keys(localStorage) in the app: expose stored keys as own properties.
  const proxy = new Proxy(storage, {
    ownKeys: (t) => t.keys(),
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
  });
  Object.assign(globalThis, { localStorage: proxy, window: new EventTarget() });
});

describe("offline copies", () => {
  it("stores and reads back data, and forgets it on sign-out", async () => {
    writeCache("plan:h1", { chores: [1, 2] });
    expect(readCache("plan:h1")).toEqual({ chores: [1, 2] });
    expect(readCache("missing")).toBeNull();
    enqueue({ type: "set_status", entryId: "e1", status: "done" });
    localStorage.setItem("hh-theme-unrelated", "keep");
    await clearOfflineData();
    expect(readCache("plan:h1")).toBeNull();
    expect(pendingCount()).toBe(0);
    expect(localStorage.getItem("hh-theme-unrelated")).toBe("keep");
  });
});

describe("outbox", () => {
  it("keeps only the latest tick for the same line or step", () => {
    enqueue({ type: "set_status", entryId: "e1", status: "done" });
    enqueue({ type: "set_status", entryId: "e1", status: "open" });
    enqueue({ type: "set_completion", kind: "step", itemId: "s1", forDate: "2026-11-13", done: true });
    enqueue({ type: "set_completion", kind: "step", itemId: "s1", forDate: "2026-11-13", done: false });
    enqueue({ type: "set_completion", kind: "step", itemId: "s1", forDate: "2026-11-14", done: true });
    enqueue({ type: "add_entry", listId: "l1", text: "Milk", quantity: null, category: null });
    enqueue({ type: "add_entry", listId: "l1", text: "Milk", quantity: null, category: null });
    expect(pendingCount()).toBe(5);
  });
});

describe("network errors", () => {
  it("recognises each browser's wording, not server refusals", () => {
    expect(isNetworkError({ message: "TypeError: Failed to fetch" })).toBe(true);
    expect(isNetworkError({ message: "Load failed" })).toBe(true);
    expect(isNetworkError({ message: "NetworkError when attempting to fetch resource." })).toBe(true);
    expect(isNetworkError({ message: "new row violates row-level security policy" })).toBe(false);
  });
});
