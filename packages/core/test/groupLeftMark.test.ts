import { describe, expect, it } from "vitest";
import { identityFromSeedB64, sign } from "../src/identity";
import { toBase64Url, utf8Encode } from "../src/bytes";
import { commitHash } from "../src/groupCommits";
import { GroupSession, type GroupCommitFrame } from "../src/groupSession";
import { Mesh, admit, clone } from "./support/groupMesh";
// covers: groups.leave, groups.remove-member

/*
 * WISP 902 § Leaving: the admin's commit that takes out a member who asked to leave carries the admin's signed mark
 * (`left`), which members keep and hand on with the commit. A removal the admin chose carries none.
 */

/** Alice (admin), Bob, Carol and Dave, all connected. */
async function four() {
  const mesh = new Mesh();
  const alice = mesh.add(GroupSession.create("Ghosts"), "Alice");
  const bob = await admit(mesh, alice, "Bob"), carol = await admit(mesh, alice, "Carol"), dave = await admit(mesh, alice, "Dave");
  return { mesh, alice, bob, carol, dave };
}
const away = (mesh: Mesh, who: GroupSession, from: GroupSession[]) => { for (const s of from) mesh.setEdge(who.myKey, s.myKey, false); };
const commitsTo = (mesh: Mesh, to: GroupSession) => mesh.sentFrames.filter(f => f.to === to.myKey && f.frame.t === "group-commit").map(f => f.frame as GroupCommitFrame);

describe("the admin marks the removal of a member who left", { timeout: 60_000 }, () => {
  it("a leave's commit carries the mark, kept by those online and handed to one who was away", async () => {
    const { mesh, alice, bob, carol, dave } = await four();
    away(mesh, dave, [alice, bob, carol]);
    await bob.leave(); await mesh.settle();
    const e = alice.epoch;
    expect(alice.state.chain[e]).toMatchObject({ k: "remove", s: bob.myKey });
    expect(alice.state.leftMarks?.[e]).toHaveLength(86);
    expect(commitsTo(mesh, carol).at(-1)!.left).toBe(alice.state.leftMarks![e]);
    expect(carol.state.leftMarks?.[e]).toBe(alice.state.leftMarks![e]);
    // Alice's app is closed; Dave is back and catches up from Carol.
    away(mesh, alice, [carol]);
    await mesh.open(dave, carol);
    expect(dave.epoch).toBe(e);
    expect(commitsTo(mesh, dave).at(-1)!.left).toBe(alice.state.leftMarks![e]);
    expect(dave.state.leftMarks?.[e]).toBe(alice.state.leftMarks![e]);
  });

  it("a signed leave carried by a member is marked too", async () => {
    const { mesh, alice, bob, carol } = await four();
    const bye = bob.byeFrame();
    away(mesh, bob, [alice]);
    await alice.handle(carol.myKey, clone(bye)); await mesh.settle();
    expect(alice.state.chain[alice.epoch]).toMatchObject({ k: "remove", s: bob.myKey });
    expect(carol.state.leftMarks?.[alice.epoch]).toBe(alice.state.leftMarks?.[alice.epoch]);
    expect(alice.state.leftMarks?.[alice.epoch]).toHaveLength(86);
  });

  it("a leave on the admin's chat is marked when the app says so", async () => {
    const { mesh, alice, bob, carol } = await four();
    await alice.remove(bob.myKey, Date.now(), { left: true }); await mesh.settle();
    expect(carol.state.leftMarks?.[alice.epoch]).toHaveLength(86);
  });

  it("a removal the admin chose carries no mark, and a member cannot add one", async () => {
    const { mesh, alice, bob, carol, dave } = await four();
    away(mesh, dave, [alice, bob, carol]);
    await alice.remove(bob.myKey); await mesh.settle();
    const e = alice.epoch;
    expect(commitsTo(mesh, carol).at(-1)).not.toHaveProperty("left");
    expect(alice.state.leftMarks).toBeUndefined();
    expect(carol.state.leftMarks).toBeUndefined();
    // Carol marks it with her own key and hands it to Dave: not the admin's signature, not taken.
    const commit = alice.state.chain[e];
    const statement = utf8Encode(JSON.stringify(["ghostly-group/1 left", alice.id, e, commitHash(commit)]));
    const forged = toBase64Url(sign(statement, identityFromSeedB64(carol.state.seedB64).seed));
    await dave.handle(carol.myKey, { t: "group-commit", g: alice.id, commit: clone(commit), left: forged }); await mesh.settle();
    expect(dave.epoch).toBe(e);
    expect(dave.state.leftMarks).toBeUndefined();
    // Nor is one the admin signed over another statement.
    const other = toBase64Url(sign(utf8Encode(JSON.stringify(["ghostly-group/1 left", alice.id, e, "0".repeat(64)])), identityFromSeedB64(alice.state.seedB64).seed));
    await dave.handle(carol.myKey, { t: "group-commit", g: alice.id, commit: clone(commit), left: other }); await mesh.settle();
    expect(dave.state.leftMarks).toBeUndefined();
    // The admin's own mark on that commit, heard after the commit itself, is taken.
    const real = toBase64Url(sign(statement, identityFromSeedB64(alice.state.seedB64).seed));
    await dave.handle(carol.myKey, { t: "group-commit", g: alice.id, commit: clone(commit), left: real }); await mesh.settle();
    expect(dave.state.leftMarks?.[e]).toBe(real);
  });
});
