import { describe, expect, it, vi } from "vitest";
import { encryptText, epochKeys } from "../src/groupCrypto";
import { fromBase64Url, toBase64Url } from "../src/bytes";
import { publicKeyFromZ32 } from "../src/identity";
import { GroupSession, type GroupMessageFrame } from "../src/groupSession";
import { Mesh, admit, clone } from "./support/groupMesh";
// covers: groups.catch-up, groups.hubs

/** The key of each Ed25519 check the sessions make. */
const verifies = vi.hoisted(() => [] as Uint8Array[]);
vi.mock("../src/identity", async importOriginal => {
  const real = await importOriginal<typeof import("../src/identity")>();
  return { ...real, verify: (signature: Uint8Array, message: Uint8Array, key: Uint8Array) => {
    verifies.push(key);
    return real.verify(signature, message, key);
  } };
});
/** The checks of signatures by `who`. */
const checksOf = (who: GroupSession) => verifies.filter(k => toBase64Url(k) === toBase64Url(publicKeyFromZ32(who.myKey))).length;

/*
 * A member's name travels with its messages (WISP 902 § Messages, "The author's name"): past 16 members a group runs
 * on hubs and a member keeps edges with a few others only, so a name said on an edge never reaches the rest.
 */

/** Alice (admin), Bob and Carol, all connected, each app saying its name in its messages. */
async function three() {
  const mesh = new Mesh();
  const alice = mesh.add(GroupSession.create("Ghosts"), "Alice");
  const bob = await admit(mesh, alice, "Bob"), carol = await admit(mesh, alice, "Carol");
  for (const [s, name] of [[alice, "Alice"], [bob, "Bob"], [carol, "Carol"]] as const) mesh.names.set(s.myKey, name);
  return { mesh, alice, bob, carol };
}
const away = (mesh: Mesh, who: GroupSession, from: GroupSession[]) => { for (const s of from) mesh.setEdge(who.myKey, s.myKey, false); };
/** A box any member of the epoch can seal: what a member handing a frame on could put in its place. */
const sealedBy = (member: GroupSession, frame: GroupMessageFrame, nick: string) =>
  encryptText(epochKeys(fromBase64Url(member.state.secrets[frame.e]), member.id, frame.e).message, JSON.stringify(["ghostly-group/1 nick", frame.g, frame.e, frame.s, frame.n, frame.ts]), nick);

describe("a member's name travels with its messages", { timeout: 60_000 }, () => {
  it("names the author of a message handed on by a member, with no edge between them ever saying it", async () => {
    const { mesh, alice, bob, carol } = await three();
    away(mesh, bob, [alice, carol]);
    await carol.sendText("hello from carol", 1_000); await mesh.settle();
    away(mesh, carol, [alice]);
    expect(bob.state.nicks[carol.myKey]).toBeUndefined();
    await mesh.open(bob, alice, { a: [carol.myKey] });
    expect(mesh.texts(bob)).toEqual(["hello from carol"]);
    expect(bob.state.nicks[carol.myKey]).toBe("Carol");
    // Kept with the frame, so whoever Bob hands it on to learns it too.
    expect(bob.state.relay!.find(f => f.s === carol.myKey)!.nk).toBeDefined();
  });

  it("takes no name a member handing the frame on put there, and a frame stripped of it stays whole", async () => {
    const { mesh, alice, bob, carol } = await three();
    away(mesh, bob, [alice, carol]);
    await carol.sendText("@Alice look", 1_000, [{ k: alice.myKey, o: 0, l: 6 }]); await mesh.settle();
    const frame = clone(carol.state.sent[0]);
    expect(frame.nk && frame.ns).toBeTruthy();
    // Alice seals another name with the epoch key she holds; Carol's signature over the box no longer holds.
    await bob.handle(alice.myKey, clone({ ...frame, nk: sealedBy(alice, frame, "Mallory") }));
    expect(bob.state.nicks[carol.myKey]).toBeUndefined();
    const got = mesh.inbox.get(bob.myKey)!.find(m => m.text === "@Alice look")!;
    // The name is outside `xs`: the message is whole all the same.
    expect(got.mentions).toEqual([{ k: alice.myKey, o: 0, l: 6 }]);
    expect(got.frame).toBeDefined();
    // An older app handing it on drops the fields it does not know: whole, with no name.
    await carol.sendText("@Alice again", 2_000, [{ k: alice.myKey, o: 0, l: 6 }]); await mesh.settle();
    const stripped = clone(carol.state.sent[1]); delete stripped.nk; delete stripped.ns;
    await bob.handle(alice.myKey, stripped);
    const second = mesh.inbox.get(bob.myKey)!.find(m => m.text === "@Alice again")!;
    expect(second.mentions).toEqual([{ k: alice.myKey, o: 0, l: 6 }]);
    expect(bob.state.nicks[carol.myKey]).toBeUndefined();
    // Handed on as Carol signed it, the next one names her.
    await carol.sendText("third", 3_000); await mesh.settle();
    await bob.handle(alice.myKey, clone(carol.state.sent[2]));
    expect(bob.state.nicks[carol.myKey]).toBe("Carol");
  });

  it("keeps the name of the newest message, whatever order they come in", async () => {
    const { mesh, alice, bob, carol } = await three();
    away(mesh, bob, [alice, carol]);
    await carol.sendText("as Carol", 1_000); await mesh.settle();
    mesh.names.set(carol.myKey, "Caz");
    await carol.sendText("as Caz", 2_000); await mesh.settle();
    const [older, newer] = carol.state.sent.map(clone);
    await bob.handle(alice.myKey, newer);
    expect(bob.state.nicks[carol.myKey]).toBe("Caz");
    await bob.handle(alice.myKey, older);
    expect(mesh.texts(bob)).toEqual(["as Caz", "as Carol"]);
    expect(bob.state.nicks[carol.myKey]).toBe("Caz");
  });

  it("checks the author's signature over a name only when it differs from the one held", async () => {
    const { mesh, alice, bob, carol } = await three();
    away(mesh, bob, [alice, carol]);
    for (let i = 1; i <= 4; i++) await carol.sendText(`m${i}`, i * 1_000);
    await mesh.settle();
    const frames = carol.state.sent.map(clone);
    verifies.length = 0;
    // Handed on oldest first: `sig` and `xs` each, and `ns` once, for the name Bob did not hold yet.
    for (const frame of frames) await bob.handle(alice.myKey, frame);
    expect(mesh.texts(bob)).toEqual(["m1", "m2", "m3", "m4"]);
    expect(bob.state.nicks[carol.myKey]).toBe("Carol");
    expect(checksOf(carol)).toBe(2 * frames.length + 1);
    // Live from Carol's edge, at Alice and Bob: `sig` only, while her name stays the same.
    mesh.setEdge(bob.myKey, carol.myKey, true);
    verifies.length = 0;
    await carol.sendText("live", 5_000); await mesh.settle();
    expect(checksOf(carol)).toBe(2);
    // A new name is checked again, and taken.
    mesh.names.set(carol.myKey, "Caz");
    verifies.length = 0;
    await carol.sendText("as Caz", 6_000); await mesh.settle();
    expect(bob.state.nicks[carol.myKey]).toBe("Caz");
    expect(checksOf(carol)).toBe(4);
  });

  it("says no name for an app that shares none, and a name that shows nothing is none", async () => {
    const { mesh, alice, bob, carol } = await three();
    mesh.names.delete(carol.myKey);
    await carol.sendText("nameless", 1_000); await mesh.settle();
    expect(carol.state.sent[0].nk).toBeUndefined();
    expect(carol.state.sent[0].ns).toBeUndefined();
    mesh.names.set(carol.myKey, "​‍ ");
    await carol.sendText("blank", 2_000); await mesh.settle();
    expect(carol.state.sent[1].nk).toBeUndefined();
    expect(bob.state.nicks[carol.myKey]).toBeUndefined();
    expect(alice.state.nicks[carol.myKey]).toBeUndefined();
  });
});
