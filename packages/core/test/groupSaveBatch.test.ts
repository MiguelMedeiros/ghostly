import { afterEach, describe, expect, it, vi } from "vitest";
import { GROUP_LIMITS, GroupSession } from "../src/groupSession";
import { createIdentity, identityFromSeedB64 } from "../src/identity";
import { Mesh, admit } from "./support/groupMesh";
// covers: groups.catch-up

/*
 * A member's saved state holds the whole hand-on log (up to 256 frames), and each message received wrote all of it
 * again: a burst of messages is now one save, within `GROUP_LIMITS.saveWithinMs`. So are the commits a member catches
 * up (its whole state, the chain growing, was written once per commit). What I send, and my status, are saved at once.
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

  it("a commit received is saved within the wait, in the same save as the messages before it", async () => {
    const { mesh, alice, bob } = await two();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await alice.sendText("before the keys change", 1_000); await mesh.settle();
    const before = saves(mesh, bob);
    expect(seenHigh(mesh, bob, alice)).toBe(-1);
    const epoch = alice.epoch;
    await alice.rotate(); await mesh.settle();
    expect(bob.epoch).toBe(alice.epoch);
    expect(saves(mesh, bob) - before).toBe(0);
    await vi.advanceTimersByTimeAsync(GROUP_LIMITS.saveWithinMs);
    expect(saves(mesh, bob) - before).toBe(1);
    expect(mesh.saved.get(bob.myKey)!.seen[alice.myKey][epoch].high).toBe(0);
    expect(mesh.saved.get(bob.myKey)!.seqEpoch).toBe(alice.epoch);
    // That save was the one due: no other follows.
    await vi.advanceTimersByTimeAsync(GROUP_LIMITS.saveWithinMs * 3);
    expect(saves(mesh, bob) - before).toBe(1);
  });

  it("a member back after many joins and leaves saves its state once, not once for each commit it catches up", async () => {
    const { mesh, alice, bob } = await two();
    mesh.setEdge(alice.myKey, bob.myKey, false);
    for (let i = 0; i < 20; i++) {
      const key = identityFromSeedB64(createIdentity().seedB64).pubKeyZ32;
      await alice.admit(key, 2_000 + i);
      await alice.remove(key, 2_000 + i, { left: true });
    }
    for (let i = 0; i < 5; i++) await alice.sendText(`line ${i}`, 3_000 + i);
    await mesh.settle();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const before = saves(mesh, bob);
    await mesh.open(bob, alice);
    expect(bob.epoch).toBe(alice.epoch);
    expect(mesh.texts(bob)).toHaveLength(5);
    // Forty commits and five messages: the state is saved within the wait, once.
    expect(saves(mesh, bob) - before).toBe(0);
    await vi.advanceTimersByTimeAsync(GROUP_LIMITS.saveWithinMs);
    expect(saves(mesh, bob) - before).toBe(1);
    const saved = mesh.saved.get(bob.myKey)!;
    expect(saved.chain).toHaveLength(alice.state.chain.length);
    expect(saved.secrets[alice.epoch]).toBeDefined();
  });

  it("a catch-up whose save was lost is asked for again and ends where the first one did", async () => {
    const { mesh, alice, bob } = await two();
    mesh.setEdge(alice.myKey, bob.myKey, false);
    for (let i = 0; i < 5; i++) await alice.admit(identityFromSeedB64(createIdentity().seedB64).pubKeyZ32, 2_000 + i);
    await mesh.settle();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const stale = structuredClone(mesh.saved.get(bob.myKey)!);
    await mesh.open(bob, alice);
    expect(bob.epoch).toBe(alice.epoch);
    // Killed before the save: the state on disk is from before the commits.
    vi.clearAllTimers();
    const again = mesh.add(stale);
    expect(again.epoch).toBeLessThan(alice.epoch);
    await mesh.open(again, alice);
    expect(again.epoch).toBe(alice.epoch);
    await again.flush();
    expect(mesh.saved.get(again.myKey)!.chain).toHaveLength(alice.state.chain.length);
  });

  it("a commit that takes me out is saved at once", async () => {
    const { mesh, alice, bob } = await two();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await alice.remove(bob.myKey, 2_000); await mesh.settle();
    expect(bob.status).toBe("removed");
    expect(mesh.saved.get(bob.myKey)!.status).toBe("removed");
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
