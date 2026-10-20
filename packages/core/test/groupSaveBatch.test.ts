import { afterEach, describe, expect, it, vi } from "vitest";
import { GROUP_LIMITS, GroupSession } from "../src/groupSession";
import { Mesh, admit } from "./support/groupMesh";
// covers: groups.catch-up

/*
 * A member's saved state holds the whole hand-on log (up to 256 frames), and each message received wrote all of it
 * again: a burst of messages is now one save, within `GROUP_LIMITS.saveWithinMs`. What changes who is in the group, or
 * what I may send next, is still saved at once.
 */

async function two() {
  const mesh = new Mesh();
  const alice = mesh.add(GroupSession.create("Ghosts"), "Alice");
  const bob = await admit(mesh, alice, "Bob");
  await alice.flush(); await bob.flush();
  return { mesh, alice, bob };
}
const saves = (mesh: Mesh, who: GroupSession) => mesh.saves.get(who.myKey) ?? 0;
const seenHigh = (mesh: Mesh, who: GroupSession, sender: GroupSession) => mesh.saved.get(who.myKey)!.seen[sender.myKey]?.[sender.epoch]?.high ?? -1;

describe("a private group's state is saved once for a burst of messages", { timeout: 60_000 }, () => {
  afterEach(() => { vi.useRealTimers(); });

  it("saves once, not once per message, when many arrive together", async () => {
    const { mesh, alice, bob } = await two();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const before = saves(mesh, bob);
    for (let i = 0; i < 100; i++) await alice.sendText(`line ${i}`, 1_000 + i);
    await mesh.settle();
    expect(mesh.texts(bob)).toHaveLength(100);
    // Every message reached Bob's app; his state waits.
    expect(saves(mesh, bob) - before).toBe(0);
    await vi.advanceTimersByTimeAsync(GROUP_LIMITS.saveWithinMs);
    expect(saves(mesh, bob) - before).toBe(1);
    const saved = mesh.saved.get(bob.myKey)!;
    expect(seenHigh(mesh, bob, alice)).toBe(99);
    expect(saved.relay).toHaveLength(100);
    // Nothing more is due.
    await vi.advanceTimersByTimeAsync(GROUP_LIMITS.saveWithinMs * 3);
    expect(saves(mesh, bob) - before).toBe(1);
  });

  it("is saved within the wait while messages keep coming, not only once they stop", async () => {
    const { mesh, alice, bob } = await two();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const before = saves(mesh, bob);
    for (let i = 0; i < 10; i++) {
      await alice.sendText(`line ${i}`, 1_000 + i); await mesh.settle();
      await vi.advanceTimersByTimeAsync(GROUP_LIMITS.saveWithinMs / 2);
    }
    // Ten messages over five waits: a save for each wait that had one, the last message included.
    expect(saves(mesh, bob) - before).toBe(5);
    expect(seenHigh(mesh, bob, alice)).toBe(9);
  });

  it("a change of the members saves at once what the messages before it left waiting", async () => {
    const { mesh, alice, bob } = await two();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await alice.sendText("before the keys change", 1_000); await mesh.settle();
    const before = saves(mesh, bob);
    expect(seenHigh(mesh, bob, alice)).toBe(-1);
    const epoch = alice.epoch;
    await alice.rotate(); await mesh.settle();
    expect(saves(mesh, bob) - before).toBe(1);
    expect(mesh.saved.get(bob.myKey)!.seen[alice.myKey][epoch].high).toBe(0);
    // That save was the one due: no other follows.
    await vi.advanceTimersByTimeAsync(GROUP_LIMITS.saveWithinMs * 3);
    expect(saves(mesh, bob) - before).toBe(1);
  });

  it("my own message is saved at once: its number is never used twice", async () => {
    const { mesh, alice } = await two();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const before = saves(mesh, alice);
    await alice.sendText("mine", 1_000);
    expect(saves(mesh, alice) - before).toBeGreaterThanOrEqual(1);
    expect(mesh.saved.get(alice.myKey)!.seq).toBe(1);
  });

  it("another member's name, however often it changes, is saved within the wait; my own at once", async () => {
    const { mesh, alice, bob } = await two();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const before = saves(mesh, alice);
    for (let i = 0; i < 100; i++) await alice.setNick(bob.myKey, i % 2 ? "Bob" : "B0b");
    expect(saves(mesh, alice) - before).toBe(0);
    expect(alice.state.nicks[bob.myKey]).toBe("Bob");
    await vi.advanceTimersByTimeAsync(GROUP_LIMITS.saveWithinMs);
    expect(saves(mesh, alice) - before).toBe(1);
    expect(mesh.saved.get(alice.myKey)!.nicks[bob.myKey]).toBe("Bob");
    await alice.setNick(alice.myKey, "Alice again");
    expect(saves(mesh, alice) - before).toBe(2);
  });

  it("an app killed before the save takes the messages again and shows none twice", async () => {
    const { mesh, alice, bob } = await two();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    for (let i = 0; i < 5; i++) await alice.sendText(`line ${i}`, 1_000 + i);
    await mesh.settle();
    // Killed: the state on disk is from before the five messages; the app's store has their rows.
    const stale = structuredClone(mesh.saved.get(bob.myKey)!);
    expect(stale.seen[alice.myKey]).toBeUndefined();
    const rows = new Set(mesh.texts(bob));
    vi.clearAllTimers();
    const again = mesh.add(stale);
    await mesh.open(again, alice);
    // Alice hands them on again; a store that keeps the first of each id (as the app's does) holds five, not ten.
    for (const m of mesh.inbox.get(again.myKey)!) rows.add(m.text);
    expect(mesh.inbox.get(again.myKey)).toHaveLength(5);
    expect(rows.size).toBe(5);
    await again.flush();
    expect(seenHigh(mesh, again, alice)).toBe(4);
    // And once saved, nothing comes a third time.
    await mesh.open(again, alice);
    expect(mesh.inbox.get(again.myKey)).toHaveLength(5);
  });
});
