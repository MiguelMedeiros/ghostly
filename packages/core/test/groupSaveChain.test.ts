import { afterEach, describe, expect, it, vi } from "vitest";
import { GROUP_LIMITS, GroupSession } from "../src/groupSession";
import { createIdentity } from "../src/identity";
import { Mesh, admit } from "./support/groupMesh";
// covers: groups.catch-up

/*
 * A save hands over a copy of the session's state: the session goes on changing its own. The membership chain carries
 * the whole roster at every commit and is never compacted, and each copy deep-copied all of it again: 1.4 ms a copy at
 * 271 commits in a group of 31 (0.1 ms without the chain), two for each message I send. A commit on the chain is signed
 * and never changes: the copy shares the commits, in an array of its own.
 */

async function two() {
  const mesh = new Mesh();
  const alice = mesh.add(GroupSession.create("Ghosts"), "Alice");
  const bob = await admit(mesh, alice, "Bob");
  await alice.flush(); await bob.flush();
  return { mesh, alice, bob };
}

describe("a private group's save copies its chain's array, not its commits", { timeout: 60_000 }, () => {
  afterEach(() => { vi.useRealTimers(); });

  it("what I send is saved with the commits the session holds, in an array the session no longer changes", async () => {
    const { mesh, alice } = await two();
    for (let i = 0; i < 5; i++) await alice.admit(createIdentity().pubKeyZ32, 2_000 + i);
    await alice.sendText("hello", 3_000);
    const saved = mesh.saved.get(alice.myKey)!;
    expect(saved.chain).toHaveLength(alice.state.chain.length);
    expect(saved.chain).not.toBe(alice.state.chain);
    saved.chain.forEach((commit, e) => expect(commit).toBe(alice.state.chain[e]));
    // The rest is a copy: the session's next message and commit leave it as it was saved.
    const seq = saved.seq, length = saved.chain.length;
    await alice.admit(createIdentity().pubKeyZ32, 4_000);
    expect(alice.state.chain.length).toBe(length + 1);
    expect(saved.chain).toHaveLength(length);
    expect(saved.seq).toBe(seq);
    expect(saved).not.toBe(alice.state);
  });

  it("a save within the wait (a message received) shares the commits too", async () => {
    const { mesh, alice, bob } = await two();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await alice.sendText("to Bob", 1_000); await mesh.settle();
    await vi.advanceTimersByTimeAsync(GROUP_LIMITS.saveWithinMs);
    const saved = mesh.saved.get(bob.myKey)!;
    expect(saved.seen[alice.myKey]).toBeDefined();
    expect(saved.chain).not.toBe(bob.state.chain);
    saved.chain.forEach((commit, e) => expect(commit).toBe(bob.state.chain[e]));
    expect(saved.seen).not.toBe(bob.state.seen);
  });
});
