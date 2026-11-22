import { describe, expect, it } from "vitest";
import { GROUP_LIMITS, GroupSession } from "../src/groupSession";
import { Mesh, admit } from "./support/groupMesh";
// covers: groups.catch-up

/*
 * A member's replay windows (`seen`, sender → epoch) go into every sync it sends (`have`, `miss`) and into its saved
 * state. A window of an epoch nobody can read any more is worth nothing: a message of that epoch is dropped before it
 * is looked at. Pruned only when the same sender wrote again, the windows of members who left (and of members who wrote
 * once, long ago) stayed for good: after 120 visitors a 7-member group's sync was 15 times its size.
 */

describe("a private group's replay windows", { timeout: 120_000 }, () => {
  it("drop the epochs nobody reads any more, of every sender, members who left included", async () => {
    const mesh = new Mesh();
    const admin = mesh.add(GroupSession.create("Churn"), "Admin");
    const quiet = await admit(mesh, admin, "Quiet");
    await quiet.sendText("once, long ago");
    await mesh.settle();
    const quietEpoch = quiet.epoch;
    const visitors: string[] = [];
    // Each visitor is two commits (let in, removed): past the epochs a member can read.
    for (let i = 0; i * 2 <= GROUP_LIMITS.secrets + 4; i++) {
      const visitor = await admit(mesh, admin, `Visitor ${i}`);
      await visitor.sendText(`hello from visitor ${i}`);
      await mesh.settle();
      await admin.remove(visitor.myKey);
      await mesh.settle();
      mesh.sessions.delete(visitor.myKey);
      visitors.push(visitor.myKey);
    }
    const oldest = admin.epoch - GROUP_LIMITS.secrets;
    expect(quietEpoch).toBeLessThan(oldest);
    const have = admin.syncFrame().have;
    const epochs = Object.values(have).flatMap(byEpoch => Object.keys(byEpoch).map(Number));
    expect(epochs.filter(e => e < oldest), "epochs nobody reads any more").toEqual([]);
    // The quiet member wrote only in an epoch past reading: it is named by no window.
    expect(have[quiet.myKey]).toBeUndefined();
    // A visitor who left in the last epochs still has its window: a handed-on copy of its message is still one copy.
    expect(have[visitors[visitors.length - 1]]).toBeDefined();
    expect(Object.keys(have).length).toBeLessThan(GROUP_LIMITS.secrets / 2 + 2);
    // What the admin saves holds no more than it says.
    expect(Object.keys(admin.state.seen).sort()).toEqual(Object.keys(have).sort());
  });
});
