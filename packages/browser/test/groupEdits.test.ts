import { afterEach, describe, expect, it, vi } from "vitest";
import { EDIT_RECEIVE_LIMIT, EDIT_SEND_LIMIT, createIdentity, parseCommunityEdit, type GroupEdit } from "@ghostly/core";
import { GROUP_EDIT_RESEND, GroupEdits, type GroupEditsHost } from "../src/engine/groupEdits";
import type { StoredMessage } from "../src/shared/types";
import { CommunityWorld, type Peer } from "./communityWorld";
// covers: groups.edit, groups.protocol.edits

/**
 * Edits in groups (WISP 9xx § Edits) on the engine: `GroupEdits` on its own (what it keeps, what it believes, its pace),
 * then on headless peers running the real group engine, a community and a private group joined by their links.
 */

/** A member's rows, patched in place as the engine's database does. */
function rows(messages: StoredMessage[]): Pick<GroupEditsHost, "messages" | "patch"> {
  return {
    messages: async chat => messages.filter(m => m.linkId === chat).sort((a, b) => a.timestamp - b.timestamp),
    patch: async (chat, id, change) => {
      const at = messages.findIndex(m => m.linkId === chat && m.id === id);
      if (at < 0) return undefined;
      const patch = change(messages[at]);
      if (!patch) return undefined;
      messages[at] = { ...messages[at], ...patch };
      return messages[at];
    },
  };
}

describe("GroupEdits on its own", () => {
  afterEach(() => { vi.useRealTimers(); });
  const me = createIdentity().pubKeyZ32, bob = createIdentity().pubKeyZ32, carol = createIdentity().pubKeyZ32;
  const chat = "group:g1";
  const mine = (n: number, text = `text ${n}`): StoredMessage => ({ linkId: chat, id: `${me}:1:${n}`, text, sender: "me", member: me, timestamp: n + 1, via: "datalink" });
  const bobs = (n: number, text = `bob ${n}`): StoredMessage => ({ linkId: chat, id: `${bob}:1:${n}`, text, sender: "peer", member: bob, timestamp: n + 100, via: "datalink" });

  function setup(messages: StoredMessage[], members = [me, bob, carol]) {
    const sent: { edit: GroupEdit; to?: string }[] = [];
    let clock = 1_000_000;
    const edits = new GroupEdits({
      ...rows(messages),
      changed: () => {},
      membership: () => ({ me, members: new Set(members), community: false, admin: true }),
      send: async (_g, edit, to) => { sent.push({ edit, ...(to && { to }) }); return null; },
      now: () => clock,
    });
    return { edits, sent, messages, tick: (ms: number) => { clock += ms; } };
  }

  it("shows mine at once, says it to the group, and keeps what it replaces", async () => {
    const { edits, sent, messages } = setup([mine(0, "Working: 0 of 3")]);
    expect(await edits.edit("g1", mine(0).id, "  Working: 1 of 3 ")).toEqual({ error: null, messageId: mine(0).id });
    await edits.flush("g1");
    expect(messages[0]).toMatchObject({ text: "Working: 1 of 3", edit: { seq: 1, history: [{ text: "Working: 0 of 3" }] } });
    expect(messages[0].edit).not.toHaveProperty("pending");
    expect(sent).toEqual([{ edit: { id: mine(0).id, e: 1, ts: 1_000_000, m: "Working: 1 of 3" } }]);
    // The same text again changes nothing and says nothing.
    await edits.edit("g1", mine(0).id, "Working: 1 of 3");
    await edits.flush("g1");
    expect(sent).toHaveLength(1);
  });

  it("refuses what is not mine to edit, empty, too long, or edited too often", async () => {
    const { edits } = setup([mine(0), bobs(0), { ...mine(1), event: "joined" }, { ...mine(2), edit: { seq: 100, at: 1, history: [] } }]);
    expect(await edits.edit("g1", bobs(0).id, "mine now")).toMatchObject({ refused: true, error: "Only your own text messages can be edited" });
    expect(await edits.edit("g1", mine(1).id, "x")).toMatchObject({ refused: true });
    expect(await edits.edit("g1", mine(0).id, "   ")).toMatchObject({ refused: true, error: expect.stringMatching(/cannot be empty/) });
    expect(await edits.edit("g1", mine(0).id, "x".repeat(16 * 1024 + 1))).toMatchObject({ refused: true, error: expect.stringMatching(/exceeds/) });
    expect(await edits.edit("g1", mine(2).id, "one more")).toMatchObject({ refused: true, error: expect.stringMatching(/100 times/) });
  });

  it("says at most EDIT_SEND_LIMIT a window; the rest go when it has room, each at its latest text", async () => {
    vi.useFakeTimers();
    const messages = Array.from({ length: EDIT_SEND_LIMIT + 2 }, (_, n) => mine(n));
    const { edits, sent, tick } = setup(messages);
    for (const m of messages) await edits.edit("g1", m.id, `${m.text}, edited`);
    await edits.flush("g1");
    expect(sent).toHaveLength(EDIT_SEND_LIMIT);
    // Edited again while it waits: only the latest goes.
    await edits.edit("g1", messages.at(-1)!.id, "the latest");
    expect(messages.at(-1)!.edit).toMatchObject({ seq: 2, pending: true });
    tick(10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    await edits.flush("g1");
    expect(sent.slice(EDIT_SEND_LIMIT).map(s => [s.edit.id, s.edit.e, s.edit.m])).toEqual([[messages.at(-2)!.id, 1, `text ${EDIT_SEND_LIMIT}, edited`], [messages.at(-1)!.id, 2, "the latest"]]);
    edits.stop();
  });

  it("takes a member's edit of its own message, the highest number winning in any order; never a new message", async () => {
    const { edits, messages } = setup([bobs(0, "v0")]);
    expect(await edits.receive("g1", bob, { id: bobs(0).id, e: 3, ts: 30, m: "v3" })).toBe("applied");
    expect(await edits.receive("g1", bob, { id: bobs(0).id, e: 2, ts: 20, m: "v2" })).toBe("stale");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ text: "v3", edit: { seq: 3, history: [{ text: "v0" }] } });
  });

  it("drops an edit of someone else's message, from someone no longer in the group, or of my own", async () => {
    const { edits, messages } = setup([bobs(0, "v0"), mine(0, "mine")], [me, bob]);
    expect(await edits.receive("g1", carol, { id: bobs(0).id, e: 1, ts: 1, m: "carol wrote this" })).toBe("dropped");
    // Carol names her own id for Bob's row: the row is Bob's, not hers.
    expect(await edits.receive("g1", bob, { id: mine(0).id, e: 1, ts: 1, m: "not yours" })).toBe("dropped");
    expect(await edits.receive("g1", me, { id: mine(0).id, e: 1, ts: 1, m: "echo" })).toBe("dropped");
    expect(messages.map(m => m.text)).toEqual(["v0", "mine"]);
  });

  it("an edit that came before its message is shown once the message is stored", async () => {
    const { edits, messages } = setup([]);
    expect(await edits.receive("g1", bob, { id: bobs(0).id, e: 1, ts: 1, m: "early" })).toBe("waiting");
    messages.push(bobs(0, "original"));
    await edits.stored(messages[0]);
    expect(messages[0]).toMatchObject({ text: "early", edit: { seq: 1 } });
  });

  it("takes at most EDIT_RECEIVE_LIMIT edits a window from one member", async () => {
    const { edits } = setup([bobs(0)]);
    const results = [];
    for (let e = 1; e <= EDIT_RECEIVE_LIMIT + 1; e++) results.push(await edits.receive("g1", bob, { id: bobs(0).id, e, ts: e, m: `v${e}` }));
    expect(results.at(-2)).toBe("applied");
    expect(results.at(-1)).toBe("dropped");
  });

  it("an edit that names me marks the message, but is never a new mention", async () => {
    const { edits, messages } = setup([bobs(0, "hi")]);
    await edits.receive("g1", bob, { id: bobs(0).id, e: 1, ts: 1, m: "hi @me", k: [{ k: me, o: 3, l: 3 }] });
    expect(messages[0]).toMatchObject({ mentions: [{ k: me, o: 3, l: 3 }], mentioned: true });
  });

  it("an edge that opens hears my latest edits again, the newest GROUP_EDIT_RESEND", async () => {
    const messages = Array.from({ length: GROUP_EDIT_RESEND + 2 }, (_, n) => ({ ...mine(n), edit: { seq: 1, at: n, history: [] } }));
    const { edits, sent } = setup([...messages, mine(99)]);
    await edits.resend("g1", carol);
    expect(sent).toHaveLength(GROUP_EDIT_RESEND);
    expect(sent.every(s => s.to === carol)).toBe(true);
    expect(sent[0].edit.id).toBe(messages[2].id);
  });
});

/** A peer of `world` with edits wired as the engine wires them. `old`: an app from before edits. */
function member(world: CommunityWorld, name: string, old = false): { peer: Peer; edits: GroupEdits } {
  // The hooks run once frames flow, after `edits` below exists.
  const peer = world.add(name, p => old ? {} : ({
    storeMessage: async message => { if (!p.messages.some(m => m.id === message.id)) { p.messages.push(message); await edits.stored(message); } },
    groupEdit: async (groupId, { sender, ...edit }) => { await edits.receive(groupId, sender, edit); },
    communityApp: async (groupId, sender, frame) => { const edit = parseCommunityEdit(frame, sender); if (edit) await edits.receive(groupId, sender, edit); },
    // As the engine does (node.ts): an edge of a private group that comes up hears my latest edits again.
    edgeUp: (groupId, peerKey) => { void edits.resend(groupId, peerKey); },
  }));
  const edits: GroupEdits = new GroupEdits({
    ...rows(peer.messages),
    changed: () => {},
    membership: groupId => {
      const view = world.view(peer, groupId);
      return view?.status === "active" && view.myKey ? { me: view.myKey, members: new Set(view.members.map(m => m.key)), community: view.profile === "community" } : undefined;
    },
    send: (groupId, edit, to) => peer.groups.sendEdit(groupId, edit, to),
    now: () => world.now,
  });
  return { peer, edits };
}

const textOf = (peer: Peer, id: string) => peer.messages.find(m => m.id === id)?.text;

describe("edits on headless peers", { timeout: 120_000 }, () => {
  it("a community: every member sees the author's latest text, one who was away too, and an older app keeps the original", async () => {
    const world = new CommunityWorld();
    const alice = member(world, "alice"), bob = member(world, "bob"), carol = member(world, "carol"), old = member(world, "old", true);
    const id = await alice.peer.groups.create("Crew");
    const link = await alice.peer.groups.enableLink(id);
    for (const m of [bob, carol, old]) await m.peer.groups.joinByLink(link);
    await world.until(() => [bob, carol, old].every(m => world.member(m.peer, id)), 10 * 60_000);
    await world.run(20_000);
    const { messageId } = await bob.peer.groups.send(id, "Working: 0 of 3");
    await world.until(() => [alice, carol, old].every(m => !!textOf(m.peer, messageId!)), 60_000);
    carol.peer.online = false;
    for (const text of ["Working: 1 of 3", "Working: 2 of 3", "Done: 3 of 3"]) expect(await bob.edits.edit(id, messageId!, text)).toMatchObject({ error: null });
    await world.until(() => textOf(alice.peer, messageId!) === "Done: 3 of 3", 60_000);
    // An edit replaced before it went is skipped: only the latest version goes (WISP 400 § Edits).
    const edit = alice.peer.messages.find(m => m.id === messageId)!.edit!;
    expect(edit.seq).toBe(3);
    expect(edit.history[0].text).toBe("Working: 0 of 3");
    expect(bob.peer.messages.find(m => m.id === messageId)!.edit).not.toHaveProperty("pending");
    // Taken by the edges to Bob's hubs: the message, and the edit riding in a frame of its own.
    expect(bob.peer.groups.taken(id, messageId!)).toBeGreaterThan(0);
    expect(bob.peer.groups.taken(id, messageId!, 3)).toBeGreaterThan(0);
    // Carol was away: whoever is there catches her up, edits included.
    carol.peer.online = true;
    await world.until(() => textOf(carol.peer, messageId!) === "Done: 3 of 3", 3 * 60_000);
    // Never a new message on any side.
    for (const m of [alice, carol]) expect(m.peer.messages.filter(x => !x.event)).toHaveLength(1);
    await world.run(5_000);
    expect(textOf(old.peer, messageId!)).toBe("Working: 0 of 3");
    // Carol cannot pass off an edit of Bob's message as hers: the group signs it as Carol's.
    await carol.peer.groups.sendCommunityApp(id, { t: "edit", id: messageId, v: 9, ts: 1, text: "carol was here" });
    await world.run(5_000);
    expect(textOf(alice.peer, messageId!)).toBe("Done: 3 of 3");
    for (const m of [alice, bob, carol]) m.edits.stop();
  });

  it("a private group: the edit goes to every member over the edges; one whose edge was down hears it when it opens, by itself", async () => {
    const world = new CommunityWorld();
    const alice = member(world, "alice"), bob = member(world, "bob"), carol = member(world, "carol");
    const id = await alice.peer.groups.create("Mesh crew", "mesh");
    const link = await alice.peer.groups.enableLink(id);
    for (const m of [bob, carol]) await m.peer.groups.joinByLink(link);
    await world.until(() => [bob, carol].every(m => world.member(m.peer, id) && world.view(m.peer, id)!.members.length === 3), 10 * 60_000);
    await world.until(() => [alice, bob, carol].every(m => world.view(m.peer, id)!.members.filter(x => !x.me).every(x => x.online)), 5 * 60_000);
    const { messageId } = await bob.peer.groups.send(id, "status: building");
    await world.until(() => [alice, carol].every(m => textOf(m.peer, messageId!) === "status: building"), 60_000);
    await bob.edits.edit(id, messageId!, "status: testing");
    await world.until(() => [alice, carol].every(m => textOf(m.peer, messageId!) === "status: testing"), 60_000);
    // Carol's app is closed while Bob edits again; when her edge to Bob opens, Bob says his latest edits again.
    carol.peer.online = false;
    await world.run(5_000);
    await bob.edits.edit(id, messageId!, "status: shipped");
    await world.until(() => textOf(alice.peer, messageId!) === "status: shipped", 60_000);
    expect(textOf(carol.peer, messageId!)).toBe("status: testing");
    carol.peer.online = true;
    // Nobody asks: Bob's side of the edge coming up says his latest edits again.
    await world.until(() => textOf(carol.peer, messageId!) === "status: shipped", 3 * 60_000);
    expect(carol.peer.messages.find(m => m.id === messageId)!.edit).toMatchObject({ seq: 2 });
    // What `group send --wait sent` reads: which edges took my message, and my edit.
    expect(bob.peer.groups.taken(id, messageId!)).toBeGreaterThanOrEqual(2);
    expect(bob.peer.groups.taken(id, messageId!, 2)).toBeGreaterThanOrEqual(2);
    expect(bob.peer.groups.taken(id, messageId!, 9)).toBe(0);
    // Alone in the group for a moment: nothing takes it, until an edge opens and the catch-up carries it.
    alice.peer.online = false; carol.peer.online = false;
    await world.run(5_000);
    const alone = (await bob.peer.groups.send(id, "anyone there?")).messageId!;
    await world.run(5_000);
    expect(bob.peer.groups.taken(id, alone)).toBe(0);
    carol.peer.online = true;
    await world.until(() => bob.peer.groups.taken(id, alone) > 0, 3 * 60_000);
    await world.until(() => textOf(carol.peer, alone) === "anyone there?", 60_000);
    for (const m of [alice, bob, carol]) m.edits.stop();
  });
});
