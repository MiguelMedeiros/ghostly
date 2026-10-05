import { describe, expect, it } from "vitest";
import { createIdentity } from "../src/identity";
import { epochKeys } from "../src/groupCrypto";
import { toBase64Url } from "../src/bytes";
import { encodeGroupMetaBody, parseGroupMetaBody } from "../src/groupMeta";
import { MESH_HUBS, mayBeHub, meshHubs, meshRendezvous, parseHubPolicy, pickMeshHubs, NO_HUB_POLICY } from "../src/groupHubs";
import { GroupSession, type GroupByeFrame, type GroupCommitFrame, type GroupEdgeFrame } from "../src/groupSession";
import { Mesh, admit, clone } from "./support/groupMesh";
// covers: groups.hubs, groups.leave, groups.remove-member

/*
 * Hubs of a private group (WISP 902 · Group Mesh § Hubs), in core: the epoch's rendezvous secret, the admin's policy in
 * the metadata, how a member picks its hubs, and what a session hands a hub to pass on.
 */

const keys = (n: number) => Array.from({ length: n }, () => createIdentity().pubKeyZ32);
function jpeg(width: number, height: number, padding = 0): Uint8Array {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return new Uint8Array([0xff, 0xd8, ...app0, ...sof, 0xff, 0xda, 0x00, 0x02, ...new Array(padding).fill(0), 0xff, 0xd9]);
}
const url = (bytes: Uint8Array) => "data:image/jpeg;base64," + btoa(String.fromCharCode(...bytes));
const JPEG = url(jpeg(128, 128));

describe("the epoch's rendezvous secret", () => {
  it("is the same for every member of an epoch, changes with the epoch and the group, and is not the message key", () => {
    const secret = new Uint8Array(32).fill(7);
    const a = meshRendezvous(secret, "g".repeat(22), 3);
    expect(meshRendezvous(secret, "g".repeat(22), 3)).toBe(a);
    expect(meshRendezvous(secret, "g".repeat(22), 4)).not.toBe(a);
    expect(meshRendezvous(secret, "h".repeat(22), 3)).not.toBe(a);
    expect(a).not.toBe(toBase64Url(epochKeys(secret, "g".repeat(22), 3).message));
    expect(() => meshRendezvous(new Uint8Array(16), "g".repeat(22), 3)).toThrow();
  });
});

describe("the admin's hub policy", () => {
  it("reads distinct member keys within the bounds, and refuses anything else", () => {
    const [a, b, c] = keys(3);
    expect(parseHubPolicy(undefined)).toEqual(NO_HUB_POLICY);
    expect(parseHubPolicy({ pin: [b, a], no: [c] })).toEqual({ pin: [a, b].sort(), no: [c] });
    expect(parseHubPolicy({ pin: [a, a] })).toBeNull();
    expect(parseHubPolicy({ pin: [a], no: [a] })).toBeNull();
    expect(parseHubPolicy({ pin: ["not a key"] })).toBeNull();
    expect(parseHubPolicy({ pin: keys(MESH_HUBS.pinned + 1) })).toBeNull();
    expect(parseHubPolicy([a])).toBeNull();
  });

  it("travels in the metadata beside the picture; one that does not hold is no policy, the picture still shows", () => {
    const [a, b] = keys(2);
    const body = encodeGroupMetaBody({ pic: JPEG, hubs: { pin: [a], no: [b] } });
    expect(parseGroupMetaBody(body)).toEqual({ pic: JPEG, hubs: { pin: [a], no: [b] } });
    // Nothing said: nothing written, as before hubs.
    expect(encodeGroupMetaBody({ pic: JPEG, hubs: NO_HUB_POLICY })).toBe(JSON.stringify({ pic: JPEG }));
    expect(parseGroupMetaBody(JSON.stringify({ pic: JPEG, hubs: { pin: [a, a] } }))).toEqual({ pic: JPEG });
    expect(() => encodeGroupMetaBody({ hubs: { pin: [a], no: [a] } })).toThrow();
  });

  it("says who may be a hub: an app that stays online or a pinned member, never an excluded one or a non-member", () => {
    const [a, b, c] = keys(3), policy = { pin: [b], no: [c] }, inRoster = (k: string) => k !== "gone";
    expect(mayBeHub(a, policy, inRoster, true)).toBe(true);
    expect(mayBeHub(a, policy, inRoster, false)).toBe(false);
    expect(mayBeHub(b, policy, inRoster, false)).toBe(true);
    expect(mayBeHub(c, policy, inRoster, true)).toBe(false);
    expect(mayBeHub("gone", policy, inRoster, true)).toBe(false);
  });
});

describe("the hubs a member counts on and picks", () => {
  const now = 10_000_000;
  it("drops stale, excluded, removed and own entries of the beacon", () => {
    const [me, a, b, c, d] = keys(5);
    const hubs = [{ key: me, ts: now, load: 0 }, { key: a, ts: now, load: 1 }, { key: b, ts: now - 120_000, load: 1 }, { key: c, ts: now, load: 1 }, { key: d, ts: now, load: 1 }];
    expect(meshHubs(hubs, me, { pin: [], no: [c] }, k => k !== d, now).map(h => h.key)).toEqual([a]);
  });

  it("picks two, spreads members over the hubs, prefers hubs that said so lately and with room, a full one rather than none", () => {
    const hubKeys = keys(4), hubs = hubKeys.map(key => ({ key, ts: now, load: 3 }));
    const counts = new Map<string, number>();
    for (const me of keys(200)) for (const key of pickMeshHubs(me, hubs, now)) counts.set(key, (counts.get(key) ?? 0) + 1);
    expect([...counts.values()].reduce((s, n) => s + n, 0)).toBe(400);
    // Rendezvous ranking: every hub takes a share, none all of them.
    for (const key of hubKeys) expect(counts.get(key)).toBeGreaterThan(60);
    const [me] = keys(1);
    const stale = [{ key: hubKeys[0], ts: now - 60_000, load: 0 }, { key: hubKeys[1], ts: now, load: 0 }, { key: hubKeys[2], ts: now, load: MESH_HUBS.hubCapacity }];
    expect(pickMeshHubs(me, stale, now)).toEqual([hubKeys[1], hubKeys[2]]);
    // Two hubs, both full (a group of 64 and more): both, not none.
    const full = hubKeys.slice(0, 2).map(key => ({ key, ts: now, load: 63 }));
    expect(pickMeshHubs(me, full, now).sort()).toEqual(hubKeys.slice(0, 2).sort());
    // One that did not take me comes last.
    expect(pickMeshHubs(me, hubs.slice(0, 3), now, new Set([hubKeys[0]]))).not.toContain(hubKeys[0]);
  });
});

/** Alice (admin), Bob (the hub), Carol and Dave; Carol and Dave have no edge with each other or with Alice. */
async function hubbed() {
  const mesh = new Mesh();
  const alice = mesh.add(GroupSession.create("Hubs"), "Alice");
  const bob = await admit(mesh, alice, "Bob"), carol = await admit(mesh, alice, "Carol"), dave = await admit(mesh, alice, "Dave");
  for (const [x, y] of [[carol, dave], [alice, carol], [alice, dave]] as const) mesh.setEdge(x.myKey, y.myKey, false);
  /** Bob, as a hub: what his session took goes to his other edges. */
  const passOn = async (from: GroupSession, frame: GroupEdgeFrame) => {
    const taken = await bob.handle(from.myKey, clone(frame));
    for (const f of taken) for (const to of [alice, carol, dave]) if (to !== from) await to.handle(bob.myKey, clone(f));
    return taken;
  };
  return { mesh, alice, bob, carol, dave, passOn };
}

describe("what a session hands a hub to pass on", { timeout: 60_000 }, () => {
  it("a message the first time only, and the others take it from the hub", async () => {
    const { mesh, bob, carol, dave, passOn } = await hubbed();
    await carol.sendText("via bob"); await mesh.settle();
    const frame = carol.state.sent[0];
    // Bob already took it over his edge from Carol: a second time is a duplicate, nothing to pass on.
    expect(await bob.handle(carol.myKey, clone(frame))).toEqual([]);
    expect(mesh.texts(bob)).toEqual(["via bob"]);
    expect(mesh.texts(dave)).toEqual([]);
    // Fresh to a hub: passed on, and the others take it from the hub.
    const { bob: hub2, carol: c2, dave: d2, mesh: m2, passOn: pass2 } = await hubbed();
    m2.setEdge(c2.myKey, hub2.myKey, false);
    await c2.sendText("fresh"); await m2.settle();
    const taken = await pass2(c2, c2.state.sent[0]);
    expect(taken.map(f => f.t)).toEqual(["group-msg"]);
    expect(m2.texts(d2)).toEqual(["fresh"]);
    expect(m2.texts(hub2)).toEqual(["fresh"]);
    void passOn;
  });

  it("a commit without the secret sealed for the hub; a member it reaches asks for its own and gets it", async () => {
    const { mesh, alice, bob, carol, dave } = await hubbed();
    mesh.setEdge(alice.myKey, bob.myKey, false);
    await alice.rotate(); await mesh.settle();
    const commit = mesh.sentFrames.filter(f => f.from === alice.myKey && f.to === bob.myKey && f.frame.t === "group-commit").pop()!.frame as GroupCommitFrame;
    mesh.setEdge(alice.myKey, bob.myKey, true);
    const taken = await bob.handle(alice.myKey, clone(commit));
    expect(taken).toHaveLength(1);
    expect(taken[0]).toEqual({ t: "group-commit", g: alice.id, commit: commit.commit });
    expect(bob.epoch).toBe(alice.epoch);
    // Carol takes it from Bob with no secret for her; she asks him, and he seals hers.
    await carol.handle(bob.myKey, clone(taken[0])); await mesh.settle();
    expect(carol.epoch).toBe(alice.epoch);
    expect(carol.readableEpochs).toContain(alice.epoch);
    await dave.handle(bob.myKey, clone(taken[0])); await mesh.settle();
    expect(dave.readableEpochs).toContain(alice.epoch);
  });

  it("nothing of a member the chain took out, even for an epoch it was in", async () => {
    const { mesh, alice, bob, carol } = await hubbed();
    await carol.sendText("before"); await mesh.settle();
    const old = clone(carol.state.sent[0]);
    old.n = 5; // a later sequence of the same epoch: new to Bob, but Carol is out by then
    await alice.remove(carol.myKey); await mesh.settle();
    expect(await bob.handle(alice.myKey, old)).toEqual([]);
  });

  it("a signed leave: the admin removes its member; a hub passes it on; a forged or foreign one is dropped", async () => {
    const { mesh, alice, bob, carol, dave } = await hubbed();
    const bye = carol.byeFrame();
    // Forged: signed by Dave, naming Carol.
    const forged: GroupByeFrame = { ...dave.byeFrame(), k: carol.myKey };
    expect(await bob.handle(dave.myKey, clone(forged))).toEqual([]);
    expect(await alice.handle(bob.myKey, clone(forged))).toEqual([]);
    expect(alice.roster.some(([k]) => k === carol.myKey)).toBe(true);
    // Bob is no admin: he passes Carol's on, to the admin he has an edge with.
    const taken = await bob.handle(carol.myKey, clone(bye));
    expect(taken).toEqual([bye]);
    await alice.handle(bob.myKey, clone(taken[0])); await mesh.settle();
    expect(alice.roster.some(([k]) => k === carol.myKey)).toBe(false);
    // Again, once out: nothing.
    expect(await bob.handle(alice.myKey, clone(bye))).toEqual([]);
  });

  it("a metadata statement, and the admin's pins and exclusions in it", async () => {
    const { mesh, alice, bob, carol, dave, passOn } = await hubbed();
    await alice.setPicture(JPEG); await mesh.settle();
    mesh.setEdge(alice.myKey, bob.myKey, false);
    await alice.setHub(dave.myKey, "pin");
    await alice.setHub(carol.myKey, "exclude");
    await expect(bob.setHub(dave.myKey, "pin")).rejects.toThrow("Only the admin");
    await expect(alice.setHub(createIdentity().pubKeyZ32, "pin")).rejects.toThrow("Not a member");
    const meta = mesh.sentFrames.filter(f => f.from === alice.myKey && f.to === bob.myKey && f.frame.t === "group-meta").pop()!.frame;
    mesh.setEdge(alice.myKey, bob.myKey, true);
    const taken = await passOn(alice, meta);
    expect(taken.map(f => f.t)).toEqual(["group-meta"]);
    for (const s of [bob, carol, dave]) {
      expect(s.hubPolicy).toEqual({ pin: [dave.myKey], no: [carol.myKey] });
      expect(s.picture).toBe(JPEG);
    }
    // Moving a member from pinned to excluded, and back to its app.
    await alice.setHub(dave.myKey, "exclude");
    expect(alice.hubPolicy).toEqual({ pin: [], no: [carol.myKey, dave.myKey].sort() });
    await alice.setHub(dave.myKey, null);
    expect(alice.hubPolicy).toEqual({ pin: [], no: [carol.myKey] });
    // The picture set afterwards keeps the policy.
    await alice.setPicture(null);
    expect(alice.hubPolicy).toEqual({ pin: [], no: [carol.myKey] });
  });
});
