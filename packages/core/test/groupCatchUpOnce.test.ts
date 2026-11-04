import { describe, expect, it } from "vitest";
import { createIdentity, identityFromSeedB64 } from "../src/identity";
import { GroupSession, type GroupCommitFrame } from "../src/groupSession";
import { Mesh, admit } from "./support/groupMesh";
// covers: groups.catch-up

/*
 * A member back behind on the membership history: each member whose edge opened while it was still behind sent it the
 * commits it missed again, once for the sync it opens its edge with and once more for the sync it sends on reading the
 * other side's (newer) one. 200 missed commits went as 400 commit frames from one member, and as 1,456 when answers go
 * a slice at a time (`hooks.handled`), each signature-checked and each with a secret sealed for it.
 */

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Alice's group of four; Bob away while Alice lets `churn` members in and out again (two commits each). */
async function awayWhileChurn(churn: number, handled: Mesh["handled"]) {
  const mesh = new Mesh();
  mesh.handled = handled;
  const alice = mesh.add(GroupSession.create("Sala"), "Alice");
  const bob = await admit(mesh, alice, "Bob");
  const others = [await admit(mesh, alice, "Carol"), await admit(mesh, alice, "Dan")];
  for (const s of [alice, ...others]) mesh.setEdge(bob.myKey, s.myKey, false);
  for (let i = 0; i < churn; i++) {
    const key = identityFromSeedB64(createIdentity().seedB64).pubKeyZ32;
    await alice.admit(key);
    await alice.remove(key);
  }
  await mesh.settle();
  mesh.sentFrames.length = 0;
  return { mesh, alice, bob, others };
}

function commitsTo(mesh: Mesh, to: string) {
  const frames = mesh.sentFrames.filter(s => s.to === to && s.frame.t === "group-commit").map(s => (s.frame as GroupCommitFrame).commit.e);
  return { frames: frames.length, distinct: new Set(frames).size };
}

describe("a member back behind on the membership history is sent each commit it missed once", { timeout: 120_000 }, () => {
  it("answers all at once: the sync it opens its edge with is its question, not one more on reading the other side's", async () => {
    const { mesh, alice, bob, others } = await awayWhileChurn(20, null);
    for (const s of [alice, ...others]) await mesh.open(bob, s);
    await mesh.settle();
    expect(bob.epoch).toBe(alice.epoch);
    expect(commitsTo(mesh, bob.myKey)).toEqual({ frames: 40, distinct: 40 });
    // Bob sent one sync to each, the one its edge opened with.
    expect(mesh.sentFrames.filter(s => s.from === bob.myKey && s.frame.t === "group-sync")).toHaveLength(0);
  });

  it("answers in slices: a newer answer to the same member leaves out the commits still queued or on their way", async () => {
    // Bob's app says it handled a slice only when the test lets it.
    const waits: (() => void)[] = [];
    const { mesh, alice, bob } = await awayWhileChurn(30, () => new Promise(resolve => waits.push(() => resolve(true))));
    await mesh.open(bob, alice);
    expect(commitsTo(mesh, bob.myKey).frames).toBe(2 * 16);
    // Bob asks Alice again while her answer is still going (a message of an epoch he lacks, his edge opening again).
    await alice.handle(bob.myKey, bob.syncFrame([], alice.myKey));
    await mesh.settle();
    for (let i = 0; i < 100 && waits.length; i++) { waits.shift()!(); await sleep(0); await mesh.settle(); }
    expect(bob.epoch).toBe(alice.epoch);
    expect(commitsTo(mesh, bob.myKey)).toEqual({ frames: 60, distinct: 60 });
  });
});
