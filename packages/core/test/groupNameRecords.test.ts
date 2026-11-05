import { describe, expect, it } from "vitest";
import { encryptText, epochKeys } from "../src/groupCrypto";
import { fromBase64Url, toBase64Url, utf8Encode } from "../src/bytes";
import { identityFromSeedB64, sign } from "../src/identity";
import { GROUP_LIMITS, GroupSession, type GroupEdgeFrame } from "../src/groupSession";
import { Mesh, admit, clone } from "./support/groupMesh";
// covers: groups.catch-up, groups.hubs

/*
 * A member's name record (WISP 902 § Messages, "The name record"): past 16 members a member keeps edges with its hubs
 * only, and a member that never writes has no message to carry its name, so it travels on its own, signed by the member.
 */

/**
 * Alice (admin, the hub), Carol, who never writes, then Bob, let in after her: Bob's only edge is Alice's, so no edge
 * between Bob and Carol ever says a name.
 */
async function hubbed() {
  const mesh = new Mesh();
  const alice = mesh.add(GroupSession.create("Ghosts"), "Alice");
  mesh.names.set(alice.myKey, "Alice");
  const carol = await admit(mesh, alice, "Carol");
  mesh.names.set(carol.myKey, "Carol");
  // Carol's edge to Alice opens again with her app sharing her name: what a member's app does when it starts.
  await mesh.open(carol, alice);
  mesh.setEdge(carol.myKey, alice.myKey, false);
  const seed = await admitAway(mesh, alice, [carol]);
  return { mesh, alice, carol, bob: seed };
}
/** Admits a member whose edges to `away` never open: only the admin's does. */
async function admitAway(mesh: Mesh, admin: GroupSession, away: GroupSession[]): Promise<GroupSession> {
  for (const s of away) mesh.setEdge(admin.myKey, s.myKey, false);
  const bob = await admit(mesh, admin, "Bob");
  for (const s of away) mesh.setEdge(bob.myKey, s.myKey, false);
  mesh.names.set(bob.myKey, "Bob");
  await mesh.open(bob, admin);
  return bob;
}
/** Alice as a hub: what her session took for the first time goes on to `to`. */
async function passOn(mesh: Mesh, hub: GroupSession, from: GroupSession, frame: GroupEdgeFrame, to: GroupSession): Promise<void> {
  const taken = await hub.handle(from.myKey, clone(frame));
  for (const f of taken) await to.handle(hub.myKey, clone(f));
  await mesh.settle();
}
const nameFramesOf = (mesh: Mesh, from: GroupSession) => mesh.sentFrames.filter(s => s.from === from.myKey && s.frame.t === "group-name");

describe("a member's name record", { timeout: 60_000 }, () => {
  it("names a member that never wrote to a member with no edge to it, handed over at sync", async () => {
    const { bob, carol } = await hubbed();
    expect(carol.state.sent).toEqual([]);
    expect(bob.state.nicks[carol.myKey]).toBe("Carol");
  });

  it("is passed on by a hub when the member changes its name, and a newer one wins whatever order they come in", async () => {
    const { mesh, alice, bob, carol } = await hubbed();
    mesh.setEdge(carol.myKey, alice.myKey, true);
    mesh.clock = Date.now() + 60_000;
    mesh.names.set(carol.myKey, "Caz");
    const before = nameFramesOf(mesh, carol).length;
    mesh.setEdge(carol.myKey, alice.myKey, false);
    await carol.sayName();
    const said = nameFramesOf(mesh, carol).slice(before);
    expect(said.length).toBeGreaterThan(0);
    const renamed = said.find(s => s.to === alice.myKey)!.frame;
    await passOn(mesh, alice, carol, renamed, bob);
    expect(alice.state.nicks[carol.myKey]).toBe("Caz");
    expect(bob.state.nicks[carol.myKey]).toBe("Caz");
    // Said again, it is not new: nothing is passed on.
    expect(await alice.handle(carol.myKey, clone(renamed))).toEqual([]);
    // An older record handed over later (a member that was away) brings nothing back.
    const older = nameFramesOf(mesh, carol)[0].frame;
    await bob.handle(alice.myKey, clone(older));
    expect(bob.state.nicks[carol.myKey]).toBe("Caz");
    // Said once on the tick: the next tick with the same name says nothing.
    const count = nameFramesOf(mesh, carol).length;
    await carol.sayName();
    expect(nameFramesOf(mesh, carol).length).toBe(count);
  });

  it("takes no name another member signed or sealed for someone else, nor one of a member removed", async () => {
    const { mesh, alice, bob, carol } = await hubbed();
    const e = alice.epoch, key = epochKeys(fromBase64Url(alice.state.secrets[e]), alice.id, e).message;
    const forged = (v: number, nm: string, signer: string) => {
      const sig = toBase64Url(sign(utf8Encode(JSON.stringify(["ghostly-group/1 name", alice.id, carol.myKey, v, nm])), identityFromSeedB64(signer).seed));
      const box = encryptText(key, JSON.stringify(["ghostly-group/1 name", alice.id, e, carol.myKey, v]), JSON.stringify({ nm, sig }));
      return { t: "group-name", g: alice.id, e, k: carol.myKey, v, nn: box.n, c: box.c };
    };
    const v = Date.now() + 120_000;
    // Signed by Alice, not by Carol: any member could seal one.
    expect(await bob.handle(alice.myKey, forged(v, "Mallory", alice.state.seedB64))).toEqual([]);
    expect(bob.state.nicks[carol.myKey]).toBe("Carol");
    // Signed by Carol: taken, and passed on.
    expect((await bob.handle(alice.myKey, forged(v, "Caz", carol.state.seedB64))).length).toBe(1);
    expect(bob.state.nicks[carol.myKey]).toBe("Caz");
    // Carol removed: her records are forgotten, and none of hers is taken any more.
    mesh.setEdge(carol.myKey, alice.myKey, true);
    await alice.remove(carol.myKey);
    await mesh.settle();
    expect(bob.state.names?.[carol.myKey]).toBeUndefined();
    expect(await bob.handle(alice.myKey, forged(v + 1, "Ghost", carol.state.seedB64))).toEqual([]);
  });

  it("a member's refused records of another cost that member nothing: its own still gets through", async () => {
    const { alice, bob, carol } = await hubbed();
    const e = alice.epoch, key = epochKeys(fromBase64Url(alice.state.secrets[e]), alice.id, e).message;
    const record = (v: number, nm: string, signer: string) => {
      const sig = toBase64Url(sign(utf8Encode(JSON.stringify(["ghostly-group/1 name", alice.id, carol.myKey, v, nm])), identityFromSeedB64(signer).seed));
      const box = encryptText(key, JSON.stringify(["ghostly-group/1 name", alice.id, e, carol.myKey, v]), JSON.stringify({ nm, sig }));
      return { t: "group-name", g: alice.id, e, k: carol.myKey, v, nn: box.n, c: box.c };
    };
    const v = Date.now() + 120_000;
    // Alice sends Bob more records "of Carol" than a minute takes, each signed by Alice.
    for (let i = 1; i <= GROUP_LIMITS.namesPerMember + 2; i++) await bob.handle(alice.myKey, record(v + i, "Mallory", alice.state.seedB64));
    expect(bob.state.nicks[carol.myKey]).toBe("Carol");
    // Carol's own rename, in the same minute, is taken.
    await bob.handle(alice.myKey, record(v + 100, "Caz", carol.state.seedB64));
    expect(bob.state.nicks[carol.myKey]).toBe("Caz");
  });

  it("is forgotten by the admin too, in its saved group, once its own commit takes the member out", async () => {
    for (const left of [false, true]) {
      const { mesh, alice, bob, carol } = await hubbed();
      expect(alice.state.names?.[carol.myKey]?.nm).toBe("Carol");
      await alice.remove(carol.myKey, Date.now(), { left });
      await mesh.settle();
      expect(alice.state.names?.[carol.myKey]).toBeUndefined();
      expect(mesh.add(clone(alice.state)).state.names?.[carol.myKey]).toBeUndefined();
      // Bob, still a member, keeps his.
      expect(alice.state.names?.[bob.myKey]?.nm).toBe("Bob");
    }
  });

  it("is kept across a restart, and an older one handed over afterwards changes nothing", async () => {
    const { mesh, alice, bob, carol } = await hubbed();
    const older = nameFramesOf(mesh, carol)[0].frame;
    const again = mesh.add(clone(bob.state));
    expect(again.state.names?.[carol.myKey]?.nm).toBe("Carol");
    expect(await again.handle(alice.myKey, clone(older))).toEqual([]);
  });
});
