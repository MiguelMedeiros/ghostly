import { describe, expect, it, vi } from "vitest";
import { toBase64Url } from "../src/bytes";
import { publicKeyFromZ32 } from "../src/identity";
import { GroupSession } from "../src/groupSession";
import { Mesh, admit, clone } from "./support/groupMesh";
// covers: groups.catch-up

/** What each Ed25519 check the sessions make signs (its domain, "ghostly-group/1 msg" or "msg+"), and by whom. */
const verifies = vi.hoisted(() => [] as { key: Uint8Array; kind: string }[]);
vi.mock("../src/identity", async importOriginal => {
  const real = await importOriginal<typeof import("../src/identity")>();
  return { ...real, verify: (signature: Uint8Array, message: Uint8Array, key: Uint8Array) => {
    const head = new TextDecoder().decode(message.slice(0, 40));
    verifies.push({ key, kind: /"ghostly-group\/1 msg\+"/.test(head) ? "msg+" : /"ghostly-group\/1 msg"/.test(head) ? "msg" : "other" });
    return real.verify(signature, message, key);
  } };
});
const checksOf = (who: GroupSession, kind: string) => verifies.filter(v => v.kind === kind && toBase64Url(v.key) === toBase64Url(publicKeyFromZ32(who.myKey))).length;

/**
 * agents#1656: a message handed on (a helper's catch-up, a hub's live hand-on) had two Ed25519 checks, `sig` and then
 * `xs`, though `xs` signs everything `sig` does (`messageSignedWhole`). One check per message is enough.
 */
async function three() {
  const mesh = new Mesh();
  const alice = mesh.add(GroupSession.create("Ghosts"));
  const bob = await admit(mesh, alice, "Bob"), carol = await admit(mesh, alice, "Carol");
  return { mesh, alice, bob, carol };
}
const away = (mesh: Mesh, who: GroupSession, from: GroupSession[]) => { for (const s of from) mesh.setEdge(who.myKey, s.myKey, false); };

describe("a message handed on is checked once", { timeout: 120_000 }, () => {
  it("a 256-message catch-up from a helper: one check per message, every message whole", async () => {
    const { mesh, alice, bob, carol } = await three();
    away(mesh, bob, [alice, carol]);
    for (let i = 1; i <= 256; i++) await carol.sendText(`m${i}`, i * 100);
    await mesh.settle();
    away(mesh, carol, [alice]);
    verifies.length = 0;
    const started = performance.now();
    await mesh.open(bob, alice, { a: [carol.myKey] });
    const ms = performance.now() - started;
    expect(mesh.texts(bob)).toHaveLength(256);
    const msg = checksOf(carol, "msg"), whole = checksOf(carol, "msg+");
    console.log(`ONE CHECK: 256 handed on, checks msg ${msg} msg+ ${whole}, ${Math.round(ms)} ms`);
    expect(whole).toBe(256);
    expect(msg).toBe(0);
    // Whole: seen and kept for handing on (a copy taken stripped is neither).
    expect(bob.state.relay!.filter(f => f.s === carol.myKey)).toHaveLength(256);
  });

  it("a frame handed on with no `xs`, or one that fails, has `sig` checked and goes the stripped way", async () => {
    const { mesh, alice, bob, carol } = await three();
    away(mesh, bob, [alice, carol]);
    await carol.sendText("one", 1_000); await carol.sendText("two", 2_000); await carol.sendText("three", 3_000);
    await mesh.settle();
    const [one, two, three_] = carol.state.sent.map(clone);
    delete one.xs;
    two.xs = two.xs!.slice(0, -2) + (two.xs!.endsWith("AA") ? "BA" : "AA");
    verifies.length = 0;
    await bob.handle(alice.myKey, one);
    await bob.handle(alice.myKey, two);
    expect(mesh.texts(bob)).toEqual(["one", "two"]);
    expect(checksOf(carol, "msg")).toBe(2);
    // Neither is kept to hand on: taken stripped, a sync still asks for them.
    expect(bob.state.relay?.filter(f => f.s === carol.myKey) ?? []).toHaveLength(0);
    // A frame whose `xs` fails and whose `sig` fails too is nobody's: dropped.
    three_.xs = three_.xs!.slice(0, -2) + (three_.xs!.endsWith("AA") ? "BA" : "AA");
    three_.sig = three_.sig.slice(0, -2) + (three_.sig.endsWith("AA") ? "BA" : "AA");
    await bob.handle(alice.myKey, three_);
    expect(mesh.texts(bob)).toEqual(["one", "two"]);
  });

  it("a message from its author's own edge has `sig` checked alone, as before", async () => {
    const { mesh, alice, carol } = await three();
    verifies.length = 0;
    await carol.sendText("live", 1_000); await mesh.settle();
    expect(mesh.texts(alice)).toContain("live");
    expect(checksOf(carol, "msg+")).toBe(0);
    expect(checksOf(carol, "msg")).toBeGreaterThan(0);
  });
});
