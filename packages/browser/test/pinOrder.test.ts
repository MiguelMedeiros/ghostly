import "fake-indexeddb/auto";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  deleteSession, isSessionPinned, listSessions, moveInOrder, movePinned, movePinnedTo, orderPinned, pinnedOrder, pinnedPlace,
  saveSession, setSessionPinned, setStorageProfile,
} from "../../../apps/ui/src/lib/storage";
import { createProfile, namespaceOf } from "../../../apps/ui/src/lib/profiles";
import { createProfileBackup, restoreProfileBackup } from "../../../apps/ui/src/lib/profileBackup";
// covers: chats.list.pin-order, chats.list.pin

class FakeStorage {
  entries = new Map<string, string>();
  get length() { return this.entries.size; }
  key(i: number) { return [...this.entries.keys()][i] ?? null; }
  getItem(k: string) { return this.entries.get(k) ?? null; }
  setItem(k: string, v: string) { this.entries.set(k, v); }
  removeItem(k: string) { this.entries.delete(k); }
}
let storage: FakeStorage;
let updates: ReturnType<typeof vi.fn>;
beforeEach(() => {
  storage = new FakeStorage();
  updates = vi.fn();
  setStorageProfile("");
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
  Object.defineProperty(globalThis, "window", { value: { dispatchEvent: updates, location: { hash: "", reload: vi.fn() } }, configurable: true });
});
afterEach(() => setStorageProfile(""));

/** Chats a (the oldest) to e (the latest). */
const chats = (ids = ["a", "b", "c", "d", "e"]) => ids.forEach((id, i) =>
  saveSession({ id, profile: "paired-chat/1", createdAt: i + 1, mySeedB64: "seed", peerPubKeyB64: `peer-${id}`, encKeyB64: "key", messages: [] }));
const shown = () => listSessions().map(s => s.id);
const pin = (...ids: string[]) => ids.forEach(id => setSessionPinned(id, true));

describe("the order model", () => {
  it("keeps the stored order for what is pinned, and puts what it does not name after it", () => {
    expect(orderPinned(["c", "gone", "a"], ["a", "b", "c"])).toEqual(["c", "a", "b"]);
    expect(orderPinned([], ["b", "a"])).toEqual(["b", "a"]);
    expect(orderPinned(["a", "a", "b"], ["b", "a"])).toEqual(["a", "b"]);
  });

  it("moves one id to a place, the ends being the ends, and says when nothing moved", () => {
    const order = ["a", "b", "c"];
    expect(moveInOrder(order, "a", 2)).toEqual(["b", "c", "a"]);
    expect(moveInOrder(order, "c", 0)).toEqual(["c", "a", "b"]);
    expect(moveInOrder(order, "a", 99)).toEqual(["b", "c", "a"]);
    expect(moveInOrder(order, "c", -3)).toEqual(["c", "a", "b"]);
    expect(moveInOrder(order, "b", 1)).toBe(order);
    expect(moveInOrder(order, "zz", 0)).toBe(order);
  });
});

describe("pinned chats in the order chosen", () => {
  it("a newly pinned chat goes to the top of the pinned ones; the rest stay the latest first under them", () => {
    chats();
    expect(shown()).toEqual(["e", "d", "c", "b", "a"]);
    pin("b", "d", "a");
    expect(pinnedOrder()).toEqual(["a", "d", "b"]);
    expect(shown()).toEqual(["a", "d", "b", "e", "c"]);
    // Pinning what is pinned already brings it to the top, once.
    pin("b");
    expect(pinnedOrder()).toEqual(["b", "a", "d"]);
  });

  it("moves up and down one place, stops at the ends, and tells the list each time", () => {
    chats();
    pin("a", "b", "c");
    expect(pinnedOrder()).toEqual(["c", "b", "a"]);
    updates.mockClear();
    expect(movePinned("a", "up")).toEqual({ index: 1, count: 3 });
    expect(shown()).toEqual(["c", "a", "b", "e", "d"]);
    expect(movePinned("a", "up")).toEqual({ index: 0, count: 3 });
    expect(updates).toHaveBeenCalledTimes(2);
    expect(movePinned("a", "up"), "already first").toBeUndefined();
    expect(movePinned("b", "down"), "already last").toBeUndefined();
    expect(movePinned("e", "up"), "not pinned").toBeUndefined();
    expect(updates).toHaveBeenCalledTimes(2);
    expect(pinnedOrder()).toEqual(["a", "c", "b"]);
    expect(pinnedPlace("c")).toEqual({ index: 1, count: 3 });
    expect(pinnedPlace("e")).toBeUndefined();
  });

  it("drops a chat at any place among the pinned ones, never outside them", () => {
    chats();
    pin("a", "b", "c");
    expect(movePinnedTo("c", 2)).toEqual({ index: 2, count: 3 });
    expect(shown()).toEqual(["b", "a", "c", "e", "d"]);
    expect(movePinnedTo("c", 7), "already last").toBeUndefined();
    expect(movePinnedTo("d", 0), "a chat that is not pinned does not move").toBeUndefined();
    expect(shown()).toEqual(["b", "a", "c", "e", "d"]);
  });

  it("unpinning and deleting take the chat out of the order; a message's time moves no pinned chat", () => {
    chats();
    pin("a", "b", "c");
    setSessionPinned("b", false);
    expect(pinnedOrder()).toEqual(["c", "a"]);
    expect(storage.getItem("ghostly_pin_order")).toBe(JSON.stringify(["c", "a"]));
    saveSession({ ...listSessions().find(s => s.id === "a")!, lastSyncAt: 1000 });
    expect(shown()).toEqual(["c", "a", "e", "d", "b"]);
    deleteSession("c");
    expect(storage.getItem("ghostly_pin_order")).toBe(JSON.stringify(["a"]));
    setSessionPinned("a", false);
    expect(storage.getItem("ghostly_pin_order"), "nothing pinned leaves nothing stored").toBeNull();
  });

  it("is each profile's own", () => {
    chats();
    pin("a", "b");
    setStorageProfile("work");
    chats(["x", "y"]);
    expect(pinnedOrder()).toEqual([]);
    pin("x", "y");
    movePinned("x", "up");
    expect(pinnedOrder()).toEqual(["x", "y"]);
    setStorageProfile("");
    expect(pinnedOrder()).toEqual(["b", "a"]);
    expect(isSessionPinned("x")).toBe(false);
  });
});

describe("pins made before the order was kept", () => {
  it("show the latest first, as they did, and take their place in the order at the first change", () => {
    chats();
    for (const id of ["a", "c", "d"]) storage.setItem(`ghostly_pin_${id}`, "1");
    expect(storage.getItem("ghostly_pin_order")).toBeNull();
    expect(pinnedOrder()).toEqual(["d", "c", "a"]);
    expect(shown()).toEqual(["d", "c", "a", "e", "b"]);
    expect(movePinned("a", "up")).toEqual({ index: 1, count: 3 });
    expect(JSON.parse(storage.getItem("ghostly_pin_order")!)).toEqual(["d", "a", "c"]);
    // One the order does not name (a pin from an older version of the app, synced in) comes after those it names.
    storage.setItem("ghostly_pin_e", "1");
    expect(shown()).toEqual(["d", "a", "c", "e", "b"]);
    expect(pinnedOrder()).toEqual(["d", "a", "c", "e"]);
  });

  it("an order that cannot be read, or names chats that are gone, is the latest first again", () => {
    chats();
    for (const id of ["a", "b"]) storage.setItem(`ghostly_pin_${id}`, "1");
    storage.setItem("ghostly_pin_order", "{not json");
    expect(shown().slice(0, 2)).toEqual(["b", "a"]);
    storage.setItem("ghostly_pin_order", JSON.stringify(["gone", 7, "a"]));
    expect(shown().slice(0, 2)).toEqual(["a", "b"]);
    // A pin left behind by a chat that is gone is not a place.
    storage.setItem("ghostly_pin_gone", "1");
    expect(pinnedOrder()).toEqual(["a", "b"]);
  });
});

describe("a profile's backup", () => {
  const PASSPHRASE = "a long backup passphrase";

  it("carries the order: the restored profile shows its pinned chats as they were put", async () => {
    const work = createProfile("Work");
    setStorageProfile(namespaceOf(work.id));
    chats();
    pin("a", "b", "c");
    movePinnedTo("a", 0);
    expect(shown()).toEqual(["a", "c", "b", "e", "d"]);
    const back = await restoreProfileBackup(await createProfileBackup(PASSPHRASE, work.id), PASSPHRASE);
    setStorageProfile(namespaceOf(back.id));
    expect(shown()).toEqual(["a", "c", "b", "e", "d"]);
    expect(movePinned("b", "up")).toEqual({ index: 1, count: 3 });
  });

  it("made before the order was kept restores with its pins, the latest first", async () => {
    const work = createProfile("Work");
    setStorageProfile(namespaceOf(work.id));
    chats();
    pin("c", "a");
    storage.removeItem(`ghostly_${namespaceOf(work.id)}_pin_order`);
    const back = await restoreProfileBackup(await createProfileBackup(PASSPHRASE, work.id), PASSPHRASE);
    setStorageProfile(namespaceOf(back.id));
    expect(shown()).toEqual(["c", "a", "e", "d", "b"]);
  });
});
