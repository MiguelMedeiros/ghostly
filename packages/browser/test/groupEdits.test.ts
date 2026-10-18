import { afterEach, describe, expect, it, vi } from "vitest";
import { EDIT_RECEIVE_LIMIT, EDIT_SEND_LIMIT, REMOVED_TEXT, createIdentity, parseCommunityEdit, type GroupEdit } from "@ghostly/core";
import { GROUP_EDITS_HELD, GROUP_EDIT_CATCH_UP, GROUP_EDIT_RESEND, GROUP_EDIT_RESEND_WINDOW_MS, GroupEdits, type GroupEditsHost } from "../src/engine/groupEdits";
import type { StoredMessage } from "../src/shared/types";
import { CommunityWorld, type Peer } from "./communityWorld";
// covers: groups.edit, groups.protocol.edits

/**
 * Edits in groups (WISP 902 § Edits) on the engine: `GroupEdits` on its own (what it keeps, what it believes, its pace),
 * then on headless peers running the real group engine, a community and a private group joined by their links.
 */

/** A member's rows, patched in place as the engine's database does; a removal deletes one, as the engine does. */
function rows(messages: StoredMessage[], removed: string[] = []): Pick<GroupEditsHost, "messages" | "patch" | "remove"> {
  return {
    remove: async (chat, id) => {
      removed.push(id);
      const at = messages.findIndex(m => m.linkId === chat && m.id === id);
      if (at >= 0) messages.splice(at, 1);
    },
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

  function setup(messages: StoredMessage[], members = [me, bob, carol], removed: string[] = []) {
    const sent: { edit: GroupEdit; to?: string }[] = [];
    let clock = 1_000_000, connection = {};
    const edits = new GroupEdits({
      ...rows(messages, removed),
      changed: () => {},
      membership: () => ({ me, members: new Set(members), community: false, admin: true }),
      send: async (_g, edit, to) => { sent.push({ edit, ...(to && { to }) }); return null; },
      edge: () => connection,
      now: () => clock,
    });
    return { edits, sent, messages, tick: (ms: number) => { clock += ms; }, reconnect: () => { connection = {}; } };
  }

  it("takes a member's card updates at most once a second, the highest of a burst last, and a card message past a text's hundred", async () => {
    vi.useFakeTimers();
    const card = (progress: number) => ({ kind: "task" as const, id: "t1", title: "Build", status: "running" as const, progress });
    const { edits, messages, tick } = setup([{ ...bobs(0, "🔄 Build"), card: card(0) }]);
    const id = bobs(0).id;
    expect(await edits.receive("g1", bob, { id, e: 1, ts: 1, m: "🔄 Build 10%", sc: card(10) })).toBe("applied");
    expect(messages[0]).toMatchObject({ card: { progress: 10 }, edit: { seq: 1, history: [] } });
    for (const e of [2, 4, 3]) await edits.receive("g1", bob, { id, e, ts: e, m: `🔄 Build ${e}0%`, sc: card(e * 10) });
    expect(messages[0].card).toMatchObject({ progress: 10 });
    tick(1_000); await vi.advanceTimersByTimeAsync(1_000);
    expect(messages[0]).toMatchObject({ card: { progress: 40 }, edit: { seq: 4 } });
    tick(1_000);
    await edits.receive("g1", bob, { id, e: 150, ts: 5, m: "🔄 Build", sc: card(99) });
    expect(messages[0]).toMatchObject({ card: { progress: 99 }, edit: { seq: 150 } });
    // A text edit leaves it a text: the card belongs to its version.
    tick(1_000);
    expect(await edits.receive("g1", bob, { id, e: 151, ts: 6, m: "plain" })).toBe("applied");
    expect(messages[0].card).toBeUndefined();
  });

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

  describe("with rows read by their id", () => {
    /** As the engine hosts it (`db.getMessage`): one row by its id, and the reads of the whole history counted. */
    function byId(messages: StoredMessage[], hooks: { row?: (id: string) => Promise<void> | void; changed?: () => void } = {}) {
      const sent: GroupEdit[] = [], reads = { n: 0 }, now = { t: 1_000_000 }, store = rows(messages);
      const edits = new GroupEdits({
        ...store,
        messages: chat => { reads.n++; return store.messages(chat); },
        message: async (chat, id) => { const row = messages.find(m => m.linkId === chat && m.id === id); await hooks.row?.(id); return row; },
        changed: () => { hooks.changed?.(); },
        membership: () => ({ me, members: new Set([me, bob, carol]), community: false, admin: true }),
        send: async (_g, edit) => { sent.push(edit); return null; },
        now: () => now.t,
      });
      return { edits, sent, reads, now };
    }

    it("reads the group's history once, then only the rows with an edit to say", async () => {
      vi.useFakeTimers();
      // One edit a run before this one left unsaid: nobody tells of it, the first look finds it.
      const messages = [mine(0, "Working: 0 of 20"), { ...mine(1), edit: { seq: 1, at: 999_000, history: [], pending: true as const } }];
      const { edits, sent, reads, now } = byId(messages);
      await edits.edit("g1", mine(0).id, "Working: 1 of 20");
      expect([sent.map(e => [e.id, e.e]), reads.n]).toEqual([[[mine(1).id, 1], [mine(0).id, 1]], 1]);
      // More than a window takes: the last ones wait for their timer, which reads no history either.
      for (let n = 2; n <= EDIT_SEND_LIMIT + 2; n++) await edits.edit("g1", mine(0).id, `Working: ${n} of 20`);
      expect(messages[0].edit).toMatchObject({ seq: EDIT_SEND_LIMIT + 2, pending: true });
      now.t += 10_000;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(sent.at(-1)).toMatchObject({ id: mine(0).id, e: EDIT_SEND_LIMIT + 2, m: `Working: ${EDIT_SEND_LIMIT + 2} of 20` });
      expect(messages.map(m => m.edit?.pending)).toEqual([undefined, undefined]);
      expect(reads.n).toBe(1);
      // A group that was forgotten starts over.
      edits.forget("g1");
      await edits.edit("g1", mine(1).id, "once more");
      expect([sent.at(-1)!.m, reads.n]).toEqual(["once more", 2]);
      edits.stop();
    });

    it("keeps a row edited again while it was read as said", async () => {
      const messages = [mine(0, "v0")];
      let again: Promise<unknown> | undefined, edit = false, written = () => {};
      // The look's read of the row, as said, comes back only once the row was edited again.
      const { edits, sent } = byId(messages, {
        row: async id => { if (!edit) return; edit = false; again = edits.edit("g1", id, "v2"); await new Promise<void>(done => { written = done; }); },
        changed: () => written(),
      });
      await edits.edit("g1", mine(0).id, "v1");
      edit = true;
      await edits.flush("g1");
      await again;
      expect(sent.map(e => [e.e, e.m])).toEqual([[1, "v1"], [2, "v2"]]);
      expect(messages[0].edit).not.toHaveProperty("pending");
    });
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

  it("an edit never turns a text into a join notice, from either side", async () => {
    const { edits, messages } = setup([bobs(0, "v0"), mine(0, "mine")]);
    expect(await edits.receive("g1", bob, { id: bobs(0).id, e: 1, ts: 1, m: "👋 Alice joined" })).toBe("dropped");
    expect(await edits.edit("g1", mine(0).id, "👋 Mallory joined")).toMatchObject({ refused: true, error: expect.stringMatching(/join notice/) });
    expect(messages.map(m => m.text)).toEqual(["v0", "mine"]);
  });

  it("a member's removal takes its own message off, a file too, whatever its number; also one not here yet", async () => {
    const removed: string[] = [];
    const file: StoredMessage = { ...bobs(1, "📎 plan.pdf"), file: { id: "f1", name: "plan.pdf", size: 3, mime: "application/pdf" } };
    const { edits, messages } = setup([bobs(0, "🔄 Task"), file], [me, bob, carol], removed);
    expect(await edits.receive("g1", bob, { id: bobs(0).id, e: 5_001, ts: 1, m: REMOVED_TEXT, rm: true })).toBe("applied");
    expect(await edits.receive("g1", bob, { id: file.id, e: 1, ts: 1, m: REMOVED_TEXT, rm: true })).toBe("applied");
    // Not here yet: kept at once, so the message is taken as gone when it comes.
    expect(await edits.receive("g1", bob, { id: bobs(2).id, e: 1, ts: 1, m: REMOVED_TEXT, rm: true })).toBe("applied");
    expect(removed).toEqual([bobs(0).id, file.id, bobs(2).id]);
    expect(messages).toEqual([]);
  });

  it("a removal never takes someone else's message, mine, a payment or a notice", async () => {
    const removed: string[] = [];
    const paid: StoredMessage = { ...bobs(1, "💸 100 sats"), paymentId: "p1" };
    const notice: StoredMessage = { ...bobs(2, "👋 Bob joined") };
    const { edits, messages } = setup([bobs(0, "v0"), mine(0, "mine"), paid, notice], [me, bob, carol], removed);
    const removal = (id: string) => ({ id, e: 1, ts: 1, m: REMOVED_TEXT, rm: true as const });
    expect(await edits.receive("g1", carol, removal(bobs(0).id))).toBe("dropped");
    expect(await edits.receive("g1", bob, removal(mine(0).id))).toBe("dropped");
    expect(await edits.receive("g1", me, removal(mine(0).id))).toBe("dropped");
    expect(await edits.receive("g1", bob, removal(paid.id))).toBe("dropped");
    expect(await edits.receive("g1", bob, removal(notice.id))).toBe("dropped");
    expect(removed).toEqual([]);
    expect(messages).toHaveLength(4);
  });

  it("an edit that came before its message is shown once the message is stored", async () => {
    const { edits, messages } = setup([]);
    expect(await edits.receive("g1", bob, { id: bobs(0).id, e: 1, ts: 1, m: "early" })).toBe("waiting");
    messages.push(bobs(0, "original"));
    await edits.stored(messages[0]);
    expect(messages[0]).toMatchObject({ text: "early", edit: { seq: 1 } });
  });

  it("takes at most EDIT_RECEIVE_LIMIT edits a window from one member; the rest wait for the next, the highest of a message", async () => {
    vi.useFakeTimers();
    const { edits, messages, tick } = setup([bobs(0), bobs(1)]);
    const results = [];
    for (let e = 1; e <= EDIT_RECEIVE_LIMIT; e++) results.push(await edits.receive("g1", bob, { id: bobs(0).id, e, ts: e, m: `v${e}` }));
    expect(results.at(-1)).toBe("applied");
    // Past the window: kept, not applied, and a lower number of a message that waits is dropped.
    expect(await edits.receive("g1", bob, { id: bobs(0).id, e: 41, ts: 41, m: "v41" })).toBe("waiting");
    expect(await edits.receive("g1", bob, { id: bobs(0).id, e: 40, ts: 40, m: "v40" })).toBe("dropped");
    expect(await edits.receive("g1", bob, { id: bobs(1).id, e: 1, ts: 42, m: "other" })).toBe("waiting");
    expect(messages.map(m => m.text)).toEqual([`v${EDIT_RECEIVE_LIMIT}`, "bob 1"]);
    tick(10_000); await vi.advanceTimersByTimeAsync(10_000);
    expect(messages.map(m => m.text)).toEqual(["v41", "other"]);
    // Nothing waits any more: the next is taken at once.
    expect(await edits.receive("g1", bob, { id: bobs(1).id, e: 2, ts: 43, m: "at once" })).toBe("applied");
    edits.stop();
  });

  it("holds GROUP_EDITS_HELD edits a group at most, the oldest going first, and none of a member who left meanwhile", async () => {
    vi.useFakeTimers();
    const rowsOfBob = Array.from({ length: GROUP_EDITS_HELD + 2 }, (_, n) => bobs(n));
    const members = [me, bob, carol];
    const { edits, messages, tick } = setup(rowsOfBob, members);
    for (let e = 1; e <= EDIT_RECEIVE_LIMIT; e++) await edits.receive("g1", bob, { id: bobs(0).id, e, ts: e, m: `v${e}` });
    for (let n = 0; n < GROUP_EDITS_HELD + 2; n++) await edits.receive("g1", bob, { id: bobs(n).id, e: 50, ts: 50, m: `held ${n}` });
    for (let window = 0; window < GROUP_EDITS_HELD / EDIT_RECEIVE_LIMIT + 2; window++) { tick(10_000); await vi.advanceTimersByTimeAsync(10_000); }
    // The first two that waited made room for the last two.
    expect(messages.filter(m => m.text.startsWith("held")).map(m => m.text)).toEqual(Array.from({ length: GROUP_EDITS_HELD }, (_, n) => `held ${n + 2}`));
    // Bob is removed while his edits wait: none of them is believed.
    for (let e = 51; e <= 50 + EDIT_RECEIVE_LIMIT; e++) await edits.receive("g1", bob, { id: bobs(2).id, e, ts: e, m: `w${e}` });
    expect(await edits.receive("g1", bob, { id: bobs(3).id, e: 99, ts: 99, m: "after he left" })).toBe("waiting");
    members.splice(members.indexOf(bob), 1);
    tick(10_000); await vi.advanceTimersByTimeAsync(10_000);
    expect(messages[3].text).toBe("held 3");
    edits.stop();
  });

  it("an edit that names me marks the message, but is never a new mention", async () => {
    const { edits, messages } = setup([bobs(0, "hi")]);
    await edits.receive("g1", bob, { id: bobs(0).id, e: 1, ts: 1, m: "hi @me", k: [{ k: me, o: 3, l: 3 }] });
    expect(messages[0]).toMatchObject({ mentions: [{ k: me, o: 3, l: 3 }], mentioned: true });
  });

  describe("an edge that opens", () => {
    const edited = (n: number, count: number) => Array.from({ length: count }, (_, i) => ({ ...mine(n + i), edit: { seq: 1, at: n + i, history: [] } }));
    const ids = (sent: { edit: GroupEdit }[]) => sent.map(s => s.edit.id);

    it("hears every edit of mine it has not heard, oldest first, GROUP_EDIT_RESEND a window", async () => {
      vi.useFakeTimers();
      const messages = edited(0, 2 * GROUP_EDIT_RESEND + 8);
      const { edits, sent, tick, reconnect } = setup([...messages, mine(99)]);
      await edits.resend("g1", carol);
      expect(ids(sent)).toEqual(messages.slice(0, GROUP_EDIT_RESEND).map(m => m.id));
      expect(sent.every(s => s.to === carol)).toBe(true);
      // Within the window nothing more goes, however often the edge says it opened.
      tick(GROUP_EDIT_RESEND_WINDOW_MS - 1);
      await edits.resend("g1", carol);
      expect(sent).toHaveLength(GROUP_EDIT_RESEND);
      // The rest follow by themselves, a window at a time.
      tick(1); await vi.advanceTimersByTimeAsync(GROUP_EDIT_RESEND_WINDOW_MS);
      expect(sent).toHaveLength(2 * GROUP_EDIT_RESEND);
      tick(GROUP_EDIT_RESEND_WINDOW_MS); await vi.advanceTimersByTimeAsync(GROUP_EDIT_RESEND_WINDOW_MS);
      expect(ids(sent)).toEqual(messages.map(m => m.id));
      // All heard: the same connection hears only what I edited since.
      tick(GROUP_EDIT_RESEND_WINDOW_MS);
      await edits.resend("g1", carol);
      expect(sent).toHaveLength(messages.length);
      await edits.edit("g1", mine(99).id, "edited since");
      await edits.flush("g1");
      sent.length = 0;
      await edits.resend("g1", carol);
      expect(ids(sent)).toEqual([mine(99).id]);
      // A new connection hears my latest GROUP_EDIT_RESEND again, heard or not: one may have come before its message.
      tick(GROUP_EDIT_RESEND_WINDOW_MS); reconnect(); sent.length = 0;
      await edits.resend("g1", carol);
      expect(ids(sent)).toEqual([...messages.slice(-(GROUP_EDIT_RESEND - 1)).map(m => m.id), mine(99).id]);
      // Another member's edge is its own: Bob has heard nothing yet.
      sent.length = 0;
      await edits.resend("g1", bob);
      expect(ids(sent.filter(s => s.to === bob))).toEqual(messages.slice(0, GROUP_EDIT_RESEND).map(m => m.id));
      edits.stop();
    });

    it("hears my newest GROUP_EDIT_CATCH_UP at most when nothing is known of what it heard", async () => {
      vi.useFakeTimers();
      const messages = edited(0, GROUP_EDIT_CATCH_UP + 5);
      const { edits, sent, tick } = setup(messages);
      await edits.resend("g1", carol);
      for (let window = 0; window < GROUP_EDIT_CATCH_UP / GROUP_EDIT_RESEND + 2; window++) { tick(GROUP_EDIT_RESEND_WINDOW_MS); await vi.advanceTimersByTimeAsync(GROUP_EDIT_RESEND_WINDOW_MS); }
      expect(ids(sent)).toEqual(messages.slice(5).map(m => m.id));
      edits.stop();
    });

    it("is told nothing while it is down, and goes on from where it was when it opens again", async () => {
      vi.useFakeTimers();
      const messages = edited(0, GROUP_EDIT_RESEND + 4);
      const sent: string[] = [], up: { edge?: object } = {};
      let clock = 1_000_000;
      const edits = new GroupEdits({
        ...rows(messages), changed: () => {}, now: () => clock,
        membership: () => ({ me, members: new Set([me, bob, carol]), community: false }),
        // The edge closes under the third edit: it went nowhere.
        send: async (_g, edit) => { sent.push(edit.id); if (sent.length === 3) up.edge = undefined; return null; },
        edge: () => up.edge,
      });
      await edits.resend("g1", carol);
      expect(sent).toHaveLength(0);
      up.edge = {};
      await edits.resend("g1", carol);
      expect(sent).toEqual(messages.slice(0, 3).map(m => m.id));
      // A new connection: from the one that was lost on, and no timer of the old one says anything.
      clock += GROUP_EDIT_RESEND_WINDOW_MS; await vi.advanceTimersByTimeAsync(GROUP_EDIT_RESEND_WINDOW_MS);
      expect(sent).toHaveLength(3);
      up.edge = {};
      await edits.resend("g1", carol);
      expect(sent.slice(3)).toEqual(messages.slice(2, 2 + GROUP_EDIT_RESEND).map(m => m.id));
      clock += GROUP_EDIT_RESEND_WINDOW_MS; await vi.advanceTimersByTimeAsync(GROUP_EDIT_RESEND_WINDOW_MS);
      expect(sent.slice(3)).toEqual(messages.slice(2).map(m => m.id));
      edits.stop();
    });
  });

  it("a private group: the author removes its card and every member forgets it; handed on again, it stays gone", async () => {
    const world = new CommunityWorld();
    const alice = member(world, "alice"), bob = member(world, "bob"), carol = member(world, "carol");
    const id = await alice.peer.groups.create("Machines", "mesh");
    const link = await alice.peer.groups.enableLink(id);
    for (const m of [bob, carol]) await m.peer.groups.joinByLink(link);
    await world.until(() => [bob, carol].every(m => world.member(m.peer, id) && world.view(m.peer, id)!.members.length === 3), 10 * 60_000);
    await world.until(() => [alice, bob, carol].every(m => world.view(m.peer, id)!.members.filter(x => !x.me).every(x => x.online)), 5 * 60_000);
    const card = { kind: "task" as const, id: "task-1", title: "Task 1", status: "running" as const };
    const { messageId } = await bob.peer.groups.send(id, "🔄 Task 1", [], undefined, undefined, card);
    await world.until(() => [alice, carol].every(m => !!textOf(m.peer, messageId!)), 60_000);
    expect(await bob.peer.groups.sendEdit(id, { id: messageId!, e: 1, ts: world.now, m: REMOVED_TEXT, rm: true })).toBeNull();
    await world.until(() => [alice, carol].every(m => !textOf(m.peer, messageId!)), 60_000);
    // A sync that hands Bob's messages on again (Carol away and back) brings nothing back.
    carol.peer.online = false;
    await world.run(5_000);
    carol.peer.online = true;
    await world.run(60_000);
    for (const m of [alice, carol]) expect(m.peer.messages.filter(x => !x.event)).toEqual([]);
    for (const m of [alice, bob, carol]) m.edits.stop();
  });

  it("a community: a member away while the author removes its message never sees it after the catch-up", async () => {
    const world = new CommunityWorld();
    const alice = member(world, "alice"), bob = member(world, "bob"), carol = member(world, "carol");
    const id = await alice.peer.groups.create("Crew");
    const link = await alice.peer.groups.enableLink(id);
    for (const m of [bob, carol]) await m.peer.groups.joinByLink(link);
    await world.until(() => [bob, carol].every(m => world.member(m.peer, id)), 10 * 60_000);
    await world.run(20_000);
    const { messageId } = await bob.peer.groups.send(id, "a mistake");
    await world.until(() => !!textOf(alice.peer, messageId!), 60_000);
    carol.peer.online = false;
    await world.run(5_000);
    expect(await bob.peer.groups.sendEdit(id, { id: messageId!, e: 1, ts: world.now, m: REMOVED_TEXT, rm: true })).toBeNull();
    await world.until(() => !textOf(alice.peer, messageId!), 60_000);
    const after = (await bob.peer.groups.send(id, "the right one")).messageId!;
    carol.peer.online = true;
    await world.until(() => textOf(carol.peer, after) === "the right one", 3 * 60_000);
    await world.run(10_000);
    expect(textOf(carol.peer, messageId!)).toBeUndefined();
    // Carol cannot remove Bob's message: the group signs her frame as hers.
    await carol.peer.groups.sendCommunityApp(id, { t: "edit", id: after, v: 1, ts: 1, text: REMOVED_TEXT, rm: true });
    await world.run(5_000);
    expect(textOf(alice.peer, after)).toBe("the right one");
    for (const m of [alice, bob, carol]) m.edits.stop();
  });
});

/** A peer of `world` with edits wired as the engine wires them. `old`: an app from before edits. */
function member(world: CommunityWorld, name: string, old = false): { peer: Peer; edits: GroupEdits } {
  // The hooks run once frames flow, after `edits` below exists.
  const peer = world.add(name, p => old ? {} : ({
    // As the engine does (node.ts `storeNewMessage`): a message its author deleted for everyone is not stored again.
    storeMessage: async message => {
      if (p.groups.isRemoved(message.linkId.slice("group:".length), message.id)) return false;
      if (!p.messages.some(m => m.id === message.id)) { p.messages.push(message); await edits.stored(message); }
    },
    groupEdit: async (groupId, { sender, ...edit }) => { await edits.receive(groupId, sender, edit); },
    communityApp: async (groupId, sender, frame) => { const edit = parseCommunityEdit(frame, sender); if (edit) await edits.receive(groupId, sender, edit); },
    // As the engine does (node.ts): an edge of a private group that comes up hears my latest edits again.
    edgeUp: (groupId, peerKey) => { void edits.resend(groupId, peerKey); },
  }));
  const edits: GroupEdits = new GroupEdits({
    ...rows(peer.messages),
    // As the engine does: noted by the group, so a copy that comes again is not stored.
    remove: async (chat, id) => {
      await peer.groups.removed(chat.slice("group:".length), id);
      const at = peer.messages.findIndex(m => m.linkId === chat && m.id === id);
      if (at >= 0) peer.messages.splice(at, 1);
    },
    changed: () => {},
    membership: groupId => {
      const view = world.view(peer, groupId);
      return view?.status === "active" && view.myKey ? { me: view.myKey, members: new Set(view.members.map(m => m.key)), community: view.profile === "community" } : undefined;
    },
    send: (groupId, edit, to) => peer.groups.sendEdit(groupId, edit, to),
    // As the engine does: the edge to a member while it is up.
    edge: (groupId, to) => { const linkId = peer.host.edges(groupId).get(to); return linkId && peer.host.linkReady(linkId) ? linkId : undefined; },
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

  it("a private group: a member back after the author closed forty task cards reads every one of them as done", async () => {
    const world = new CommunityWorld();
    const alice = member(world, "alice"), bob = member(world, "bob"), carol = member(world, "carol");
    const id = await alice.peer.groups.create("Machines", "mesh");
    const link = await alice.peer.groups.enableLink(id);
    for (const m of [bob, carol]) await m.peer.groups.joinByLink(link);
    await world.until(() => [bob, carol].every(m => world.member(m.peer, id) && world.view(m.peer, id)!.members.length === 3), 10 * 60_000);
    await world.until(() => [alice, bob, carol].every(m => world.view(m.peer, id)!.members.filter(x => !x.me).every(x => x.online)), 5 * 60_000);
    const card = (n: number, status: "running" | "done") => ({ kind: "task" as const, id: `task-${n}`, title: `Task ${n}`, status });
    const cards: string[] = [];
    for (let n = 0; n < 40; n++) {
      cards.push((await bob.peer.groups.send(id, `🔄 Task ${n}`, [], undefined, undefined, card(n, "running"))).messageId!);
      await world.run(1_000);
    }
    const statusOf = (peer: Peer, messageId: string) => peer.messages.find(m => m.id === messageId)?.card?.status;
    await world.until(() => cards.every(c => statusOf(carol.peer, c) === "running"), 60_000);
    // Carol's phone is away while Bob closes every card: one edit each, said to the edges that are up at Bob's pace.
    carol.peer.online = false;
    await world.run(5_000);
    for (let n = 0; n < 40; n++) expect(await bob.edits.edit(id, cards[n], `✅ Task ${n}`, [], card(n, "done"))).toMatchObject({ error: null });
    const carolKey = world.view(carol.peer, id)!.myKey!;
    // Bob's timers, by the world's clock: his edits that wait for the pace, and what an open edge still has to hear.
    const turn = async () => { await world.run(1_000); await bob.edits.flush(id); await bob.edits.resend(id, carolKey); };
    for (let waited = 0; !cards.every(c => statusOf(alice.peer, c) === "done"); waited++) { expect(waited).toBeLessThan(120); await turn(); }
    expect(cards.filter(c => statusOf(carol.peer, c) === "done")).toHaveLength(0);
    carol.peer.online = true;
    // Forty is more than one window carries (GROUP_EDIT_RESEND): the rest follow, a window at a time, none left out.
    for (let waited = 0; !cards.every(c => statusOf(carol.peer, c) === "done"); waited++) {
      if (waited >= 300) throw new Error(`Carol reads ${cards.filter(c => statusOf(carol.peer, c) === "done").length} of 40 cards as done`);
      await turn();
    }
    expect(carol.peer.messages.filter(m => !m.event)).toHaveLength(40);
    // An edit takes no number of its own: nothing of Bob's reads as missing at Carol.
    expect(world.view(carol.peer, id)!.members.find(m => m.key === world.view(bob.peer, id)!.myKey)).toMatchObject({ missing: 0 });
    for (const m of [alice, bob, carol]) m.edits.stop();
  });

  it("a community: a member back after the author closed forty task cards reads every one of them as done", async () => {
    const world = new CommunityWorld();
    const alice = member(world, "alice"), bob = member(world, "bob"), carol = member(world, "carol");
    const id = await alice.peer.groups.create("Machines");
    const link = await alice.peer.groups.enableLink(id);
    for (const m of [bob, carol]) await m.peer.groups.joinByLink(link);
    await world.until(() => [bob, carol].every(m => world.member(m.peer, id)), 10 * 60_000);
    await world.run(20_000);
    const card = (n: number, status: "running" | "done") => ({ kind: "task" as const, id: `task-${n}`, title: `Task ${n}`, status });
    const cards: string[] = [];
    for (let n = 0; n < 40; n++) {
      cards.push((await bob.peer.groups.send(id, `🔄 Task ${n}`, [], undefined, undefined, card(n, "running"))).messageId!);
      await world.run(1_000);
    }
    const statusOf = (peer: Peer, messageId: string) => peer.messages.find(m => m.id === messageId)?.card?.status;
    await world.until(() => cards.every(c => statusOf(carol.peer, c) === "running"), 60_000);
    carol.peer.online = false;
    await world.run(5_000);
    for (let n = 0; n < 40; n++) expect(await bob.edits.edit(id, cards[n], `✅ Task ${n}`, [], card(n, "done"))).toMatchObject({ error: null });
    // The engines' timers by the world's clock: Bob's edits that wait for his pace, Carol's that wait for her window.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const turn = async () => { await world.run(1_000); await vi.advanceTimersByTimeAsync(1_000); await bob.edits.flush(id); };
      for (let waited = 0; !cards.every(c => statusOf(alice.peer, c) === "done"); waited++) { expect(waited).toBeLessThan(120); await turn(); }
      carol.peer.online = true;
      // The catch-up hands back forty edits of Bob at once: thirty in her window, the ten others in the next.
      for (let waited = 0; !cards.every(c => statusOf(carol.peer, c) === "done"); waited++) {
        if (waited >= 300) throw new Error(`Carol reads ${cards.filter(c => statusOf(carol.peer, c) === "done").length} of 40 cards as done`);
        await turn();
      }
      expect(carol.peer.messages.filter(m => !m.event)).toHaveLength(40);
    } finally { vi.useRealTimers(); }
    for (const m of [alice, bob, carol]) m.edits.stop();
  });
});
