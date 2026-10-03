import { describe, expect, it } from "vitest";
import { GROUP_VERSION_SIGNALS, SIGNALS_PER_MINUTE, SIGNAL_HOLD_MS, SIGNAL_REPLY_MS, createIdentity, groupSignalFrame, type GroupSession, type Roster } from "@ghostly/core";
import { MeshSignals } from "../src/engine/meshSignals";
import type { GroupsHost } from "../src/engine/groups";
import type { StoredGroup } from "../src/shared/types";
// covers: groups.protocol.signals

const G = "g".repeat(22);
const bytes = (text: string) => new TextEncoder().encode(text);
const text = (payload: Uint8Array) => new TextDecoder().decode(payload);

interface Link { kind: "edge" | "entry" | "chat"; to: string; up: boolean; signals: boolean }

/** One member's side: its links, what its edges took, and its own packets for edges that are down. */
class Member {
  readonly key = createIdentity().pubKeyZ32;
  readonly links = new Map<string, Link>();
  /** `<edge link id> <text>` for each carried packet an edge took. */
  readonly took: string[] = [];
  /** edge link id → my packet for it. */
  readonly mine = new Map<string, Uint8Array>();
  contacts: Record<string, string> = {};
  now = 1_000_000;
  signals!: MeshSignals;
  constructor(readonly name: string, readonly net: Net) {}
}

/** Members whose links deliver frames straight to the other end, as open paired links do. */
class Net {
  readonly members = new Map<string, Member>();
  roster: Roster = [];
  admin = "";
  sent = 0;

  add(name: string, role: "admin" | "member" = "member"): Member {
    const member = new Member(name, this);
    this.members.set(member.key, member);
    this.roster = [...this.roster, [member.key, role]] as Roster;
    if (role === "admin") this.admin = member.key;
    const host = {
      sendOnLink: (linkId: string, frame: object) => {
        const link = member.links.get(linkId);
        if (!link?.up) throw new Error("down");
        const other = this.members.get(link.to)!;
        const back = [...other.links.entries()].find(([, l]) => l.to === member.key && l.kind === link.kind)!;
        this.sent++;
        // The other end knows which member an edge or a chat is with; an entry session's admin side, to the joiner, is the entry key.
        other.signals.received(back[0], link.kind === "entry" && other.key !== this.admin ? undefined : member.key, structuredClone(frame));
      },
      linkReady: (linkId: string, version = 1) => { const link = member.links.get(linkId); return !!link?.up && (version !== GROUP_VERSION_SIGNALS || link.signals); },
      edges: () => new Map([...member.links].filter(([, l]) => l.kind === "edge").map(([id, l]) => [l.to, id])),
      entries: () => new Map([...member.links].filter(([, l]) => l.kind === "entry").map(([id, l]) => [l.to, id])),
      signalIn: (linkId: string, payload: Uint8Array, direct?: boolean) => { const line = `${linkId} ${direct ? "(direct) " : ""}${text(payload)}`; if (member.took.includes(line)) return false; member.took.push(line); return true; },
      edgeSignal: (linkId: string) => member.mine.get(linkId) ?? null,
    } as unknown as GroupsHost;
    member.signals = new MeshSignals(host, {
      session: () => ({ myKey: member.key, admin: this.admin, roster: this.roster, others: this.roster.map(([key]) => key).filter(key => key !== member.key), status: "active" }) as unknown as GroupSession,
      stored: () => ({ id: G, createdAt: 0, contacts: member.contacts }) as StoredGroup,
      now: () => member.now,
    });
    return member;
  }

  /** A link of `kind` between two members; `up`: open, with both apps carrying signals unless `signals` says not. */
  link(a: Member, b: Member, kind: Link["kind"], up = true, signals = true): void {
    a.links.set(`${kind}:${a.name}>${b.name}`, { kind, to: b.key, up, signals });
    b.links.set(`${kind}:${b.name}>${a.name}`, { kind, to: a.key, up, signals });
  }
}

/** The admin with an edge to two members whose own edge is down. */
function three() {
  const net = new Net();
  const alice = net.add("alice", "admin"), bob = net.add("bob"), carol = net.add("carol");
  net.link(alice, bob, "edge"); net.link(alice, carol, "edge"); net.link(bob, carol, "edge", false);
  return { net, alice, bob, carol };
}

describe("edge signaling through members", () => {
  it("a member that reaches both ends passes the packet on, and the other end's goes back the same way", () => {
    const { net, alice, bob, carol } = three();
    carol.mine.set("edge:carol>bob", bytes("carol is here"));
    // Through the admin, which keeps an edge with everyone: as good as sure.
    expect(bob.signals.carry(G, carol.key, bytes("bob's offer"))).toEqual({ taken: 1, sure: true });
    expect(carol.took).toEqual(["edge:carol>bob bob's offer"]);
    expect(bob.took).toEqual(["edge:bob>carol carol is here"]);
    expect(alice.took).toEqual([]);
    // Bob's, passed on, Carol's, passed on.
    expect(net.sent).toBe(4);
    // Hers went back once: his next packet is taken, and that is all.
    bob.signals.carry(G, carol.key, bytes("bob's second"));
    expect(net.sent).toBe(6);
    carol.now += SIGNAL_REPLY_MS;
    carol.mine.set("edge:carol>bob", bytes("carol's answer"));
    bob.signals.carry(G, carol.key, bytes("bob's third"));
    expect(bob.took).toEqual(["edge:bob>carol carol is here", "edge:bob>carol carol's answer"]);
  });

  it("through a member that is not the admin it is carried, and not sure to arrive", () => {
    const net = new Net();
    const alice = net.add("alice", "admin"), bob = net.add("bob"), carol = net.add("carol");
    // Carol's app is back: her edges are down, and Alice and Bob reach each other.
    net.link(alice, bob, "edge"); net.link(alice, carol, "edge", false); net.link(bob, carol, "edge", false);
    expect(alice.signals.carry(G, carol.key, bytes("alice's answer"))).toEqual({ taken: 1, sure: false });
    expect(bob.signals.carry(G, carol.key, bytes("bob's answer"))).toEqual({ taken: 1, sure: true });
  });

  it("goes nowhere when no member is reachable, and through no member whose app does not carry signals", () => {
    const net = new Net();
    const alice = net.add("alice", "admin"), bob = net.add("bob"), carol = net.add("carol");
    net.link(bob, carol, "edge", false);
    expect(bob.signals.carry(G, carol.key, bytes("offer")).taken).toBe(0);
    net.link(alice, bob, "edge", true, false); net.link(alice, carol, "edge");
    expect(bob.signals.carry(G, carol.key, bytes("offer")).taken).toBe(0);
    expect(bob.signals.carry(G, createIdentity().pubKeyZ32, bytes("to nobody in the group")).taken).toBe(0);
    expect(bob.signals.carry(G, bob.key, bytes("to myself")).taken).toBe(0);
  });

  it("is passed on once, and only by the member its sender handed it to", () => {
    const { net, alice, bob, carol } = three();
    const dave = net.add("dave");
    net.link(alice, dave, "edge"); net.link(carol, dave, "edge");
    // Already passed on: Alice hands it to nobody.
    alice.signals.received("edge:alice>bob", bob.key, groupSignalFrame(G, bob.key, carol.key, bytes("offer"), true));
    // Not Bob's own: a member cannot hand on what it says is someone else's.
    alice.signals.received("edge:alice>bob", bob.key, groupSignalFrame(G, dave.key, carol.key, bytes("offer")));
    // For someone who is not a member.
    alice.signals.received("edge:alice>bob", bob.key, groupSignalFrame(G, bob.key, createIdentity().pubKeyZ32, bytes("offer")));
    expect(carol.took).toEqual([]);
    expect(net.sent).toBe(0);
  });

  it("a joiner's packets go over its entry session: to the admin directly, to a member through the admin", () => {
    const net = new Net();
    const alice = net.add("alice", "admin"), bob = net.add("bob"), carol = net.add("carol");
    net.link(alice, bob, "edge");
    // Carol was just admitted: her entry session is up, her edges are not.
    net.link(alice, carol, "entry"); net.link(alice, carol, "edge", false); net.link(bob, carol, "edge", false);
    carol.signals.keep(G, "entry:carol>alice");
    alice.mine.set("edge:alice>carol", bytes("alice is here")); bob.mine.set("edge:bob>carol", bytes("bob is here"));
    expect(carol.signals.carry(G, alice.key, bytes("carol to alice")).taken).toBe(1);
    expect(alice.took).toEqual(["edge:alice>carol carol to alice"]);
    expect(carol.took).toEqual(["edge:carol>alice alice is here"]);
    expect(carol.signals.carry(G, bob.key, bytes("carol to bob")).taken).toBe(1);
    expect(bob.took).toEqual(["edge:bob>carol carol to bob"]);
    expect(carol.took).toEqual(["edge:carol>alice alice is here", "edge:carol>bob bob is here"]);
    // The admin's own go to the joiner over the session too, while it is up.
    expect(alice.signals.carry(G, carol.key, bytes("alice's offer")).taken).toBe(1);
    expect(carol.took).toContain("edge:carol>alice alice's offer");
    // Released: the entry session is the admin's edge's business no more.
    expect(carol.signals.release(G, "entry:carol>alice")).toBe(true);
    expect(carol.signals.release(G, "entry:carol>alice")).toBe(false);
    expect(carol.signals.keptEntry(G)).toBeUndefined();
  });

  it("the chat an invitation went over carries the edge's packets of the two", () => {
    const net = new Net();
    const alice = net.add("alice", "admin"), bob = net.add("bob");
    net.link(alice, bob, "chat"); net.link(alice, bob, "edge", false);
    alice.contacts = { [bob.key]: "chat:alice>bob" }; bob.contacts = { [alice.key]: "chat:bob>alice" };
    expect(alice.signals.carry(G, bob.key, bytes("alice's offer")).taken).toBe(1);
    expect(bob.took).toEqual(["edge:bob>alice alice's offer"]);
  });

  it("a packet for an edge that is not started yet waits for it, once", () => {
    const { bob, carol } = three();
    carol.links.delete("edge:carol>bob");
    bob.signals.carry(G, carol.key, bytes("early"));
    expect(carol.took).toEqual([]);
    expect(text(carol.signals.take(G, bob.key)!)).toBe("early");
    expect(carol.signals.take(G, bob.key)).toBeUndefined();
  });

  it("an edge that comes up is handed my packets for the edges still down", () => {
    const net = new Net();
    const alice = net.add("alice", "admin"), bob = net.add("bob"), carol = net.add("carol"), dave = net.add("dave");
    for (const [a, b] of [[alice, bob], [alice, carol], [alice, dave], [bob, carol], [bob, dave], [carol, dave]]) net.link(a, b, "edge", false);
    for (const other of [bob, carol, dave]) alice.mine.set(`edge:alice>${other.name}`, bytes(`alice to ${other.name}`));
    // Everyone restarted; Alice's edge with Bob is the first up, and Bob's with Carol was up already.
    alice.links.get("edge:alice>bob")!.up = bob.links.get("edge:bob>alice")!.up = true;
    bob.links.get("edge:bob>carol")!.up = carol.links.get("edge:carol>bob")!.up = true;
    const session = { myKey: alice.key, others: [bob.key, carol.key, dave.key] } as unknown as GroupSession;
    alice.signals.edgeReady(G, session, bob.key, "edge:alice>bob");
    expect(carol.took).toEqual(["edge:carol>alice alice to carol"]);
    expect(dave.took).toEqual([]);
  });

  it("an edge that is up hands its packet over itself, to an app that takes them, and nothing comes back", () => {
    const { net, alice, bob, carol } = three();
    bob.mine.set("edge:bob>alice", bytes("bob's settled"));
    expect(alice.signals.direct(G, bob.key, "edge:alice>bob", bytes("alice's settled"))).toBe(true);
    expect(bob.took).toEqual(["edge:bob>alice (direct) alice's settled"]);
    expect(alice.took).toEqual([]);
    expect(net.sent).toBe(1);
    // Not over another member's edge, nor over an edge that is down or whose member's app takes no carried packets.
    expect(alice.signals.direct(G, carol.key, "edge:alice>bob", bytes("wrong edge"))).toBe(false);
    expect(bob.signals.direct(G, carol.key, "edge:bob>carol", bytes("down"))).toBe(false);
    const old = new Net();
    const dan = old.add("dan", "admin"), eve = old.add("eve");
    old.link(dan, eve, "edge", true, false);
    expect(dan.signals.direct(G, eve.key, "edge:dan>eve", bytes("older app"))).toBe(false);
    expect(old.sent).toBe(0);
  });

  it("a frame for a member whose edge is a moment from up waits for it, a few seconds", () => {
    const net = new Net();
    const alice = net.add("alice", "admin"), bob = net.add("bob"), carol = net.add("carol");
    net.link(alice, bob, "edge"); net.link(alice, carol, "edge", false); net.link(bob, carol, "edge", false);
    const session = { myKey: alice.key, roster: net.roster, others: [bob.key, carol.key] } as unknown as GroupSession;
    // Carol's app is back and Bob answers her offer; Alice's edge with Carol is not up yet.
    expect(bob.signals.carry(G, carol.key, bytes("bob's first")).taken).toBe(1);
    expect(bob.signals.carry(G, carol.key, bytes("bob's answer")).taken).toBe(1);
    expect(carol.took).toEqual([]);
    alice.links.get("edge:alice>carol")!.up = carol.links.get("edge:carol>alice")!.up = true;
    alice.signals.edgeReady(G, session, carol.key, "edge:alice>carol");
    // The newest one, once.
    expect(carol.took).toEqual(["edge:carol>bob bob's answer"]);
    alice.signals.edgeReady(G, session, carol.key, "edge:alice>carol");
    expect(carol.took).toHaveLength(1);
    // One that waited too long is dropped: the relays have it by then.
    alice.links.get("edge:alice>carol")!.up = false;
    bob.signals.carry(G, carol.key, bytes("bob's late one"));
    alice.now += SIGNAL_HOLD_MS;
    alice.links.get("edge:alice>carol")!.up = true;
    alice.signals.edgeReady(G, session, carol.key, "edge:alice>carol");
    expect(carol.took).toHaveLength(1);
  });

  it("passes on a bounded number of one member's frames a minute", () => {
    const { alice, bob, carol } = three();
    for (let i = 0; i < SIGNALS_PER_MINUTE + 20; i++) bob.signals.carry(G, carol.key, bytes(`packet ${i}`));
    expect(carol.took).toHaveLength(SIGNALS_PER_MINUTE);
    alice.now += 60_000;
    bob.signals.carry(G, carol.key, bytes("a minute later"));
    expect(carol.took).toHaveLength(SIGNALS_PER_MINUTE + 1);
  });
});
