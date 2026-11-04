import { afterEach, describe, expect, it, vi } from "vitest";
import { CommunityWorld, type Peer } from "./communityWorld";
import { MESH_SYNC_HOLD_MS } from "../src/engine/groups";
// covers: groups.catch-up

/**
 * What a member back in a private group reads of what the others wrote meanwhile (WISP 902 § Catch-up): the
 * conversation in the order it was written, though every member's edge opens within a moment of the first. The first
 * member is asked for everyone's messages and holds them in that order; the others' own answers must not race it.
 */

async function meshOf(names: string[]): Promise<{ world: CommunityWorld; peers: Peer[]; id: string }> {
  const world = new CommunityWorld(undefined, null);
  const [admin, ...rest] = names.map(name => world.add(name));
  const id = await admin.groups.create("Turns", "mesh");
  const link = await admin.groups.enableLink(id);
  for (const p of rest) await p.groups.joinByLink(link);
  const peers = [admin, ...rest];
  await world.until(() => peers.every(p => world.view(p, id)?.members.length === peers.length && world.view(p, id)!.members.every(m => m.online)), 20 * 60_000, 1000);
  return { world, peers, id };
}

/** Each of `writers` in turn, `turns` times; what they wrote, in order. Two never share a millisecond. */
async function talk(world: CommunityWorld, id: string, writers: Peer[], turns: number): Promise<string[]> {
  const written: string[] = [];
  for (let turn = 0; turn < turns; turn++) for (const p of writers) {
    const text = `${p.name} ${turn}`;
    written.push(text);
    await p.groups.send(id, text);
    await new Promise(done => setTimeout(done, 2));
    await world.run(1_000);
  }
  return written;
}

/**
 * `back` opens again: its edge to `first` comes up, and the others' only once it has told `first` where it is, in the
 * same moment, as edges do that open one after another. `first`'s frames reach it four at a time.
 */
function comesBack(world: CommunityWorld, back: Peer, first: Peer): void {
  let told = false;
  world.drop = (from, to, frame) => { if (from === back && to === first && frame.t === "group-sync") told = true; return false; };
  world.holdEdge = (a, b) => (a === back || b === back) && a !== first && b !== first && !told;
  world.slow = (from, to) => from === first && to === back ? 4 : 0;
  world.reopen(back);
}

/**
 * A mesh whose `slow` member's app handles `rate` group frames a second, every member's in one queue, as a phone's
 * single thread does: `linkHandled` says when nothing of that way is queued any more, `linkWaiting` how much is.
 * Turned on with `start`, once the members are in.
 */
async function slowAppMesh(names: string[], slowName: string, rate: number) {
  const world = new CommunityWorld(undefined, null);
  const queue: { from: Peer; frame: Record<string, unknown> }[] = [];
  const waiters: { from: string; done: (v: boolean) => void }[] = [];
  const keyOf = new Map<Peer, string>();
  let slow: Peer | null = null, groupId = "";
  const nameOf = (peer: Peer, linkId: string) => [...keyOf].find(([, key]) => key === peer.links.get(linkId)?.peer)?.[0].name;
  const extra = (peer: Peer) => ({
    linkHandled: (linkId: string) => new Promise<boolean>(done => { const to = nameOf(peer, linkId); if (to === slowName) waiters.push({ from: peer.name, done }); else done(false); }),
    linkWaiting: (linkId: string) => { const from = nameOf(peer, linkId); return peer === slow ? queue.filter(item => item.from.name === from).length : 0; },
  });
  const run = world.run.bind(world);
  world.run = async (ms: number, step = 1000) => {
    for (let t = 0; t < ms; t += step) {
      await run(step, step);
      if (!slow?.online) { queue.length = 0; continue; }
      for (const { from, frame } of queue.splice(0, rate)) if (from.online) await slow.groups.handleEdgeFrame(groupId, keyOf.get(from)!, frame);
      for (const waiter of waiters.splice(0)) if (queue.some(item => item.from.name === waiter.from)) waiters.push(waiter); else waiter.done(true);
      await world.settle();
    }
  };
  const [admin, ...rest] = names.map(name => world.add(name, extra));
  const id = groupId = await admin.groups.create("Turns", "mesh");
  const link = await admin.groups.enableLink(id);
  for (const p of rest) await p.groups.joinByLink(link);
  const peers = [admin, ...rest];
  await world.until(() => peers.every(p => world.view(p, id)?.members.length === peers.length && world.view(p, id)!.members.every(m => m.online)), 20 * 60_000, 1000);
  for (const p of peers) keyOf.set(p, world.view(p, id)!.myKey!);
  const start = (onFrame: (from: Peer, frame: Record<string, unknown>) => void) => {
    slow = peers.find(p => p.name === slowName)!;
    world.drop = (from, to, frame) => {
      if (to !== slow) return false;
      onFrame(from, frame);
      queue.push({ from, frame });
      return true;
    };
  };
  return { world, peers, id, start };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("a member back in a private group reads what it missed in the order it was written", { timeout: 120_000 }, () => {
  it("five members, four wrote in turn: no member's lines come ahead of their turn", async () => {
    const { world, peers, id } = await meshOf(["alice", "bob", "carol", "dave", "eve"]);
    const [alice, bob, carol, dave, eve] = peers;
    dave.online = false;
    await world.run(2_000);
    const written = await talk(world, id, [alice, bob, carol, eve], 6);
    comesBack(world, dave, alice);
    await world.until(() => world.texts(dave, id).filter(t => written.includes(t)).length === written.length, 60_000);
    expect(world.texts(dave, id).filter(t => written.includes(t))).toEqual(written);
  });

  it("the member asked first was away too: the others are told one after another, each asked for the rest", async () => {
    const { world, peers, id } = await meshOf(["alice", "bob", "carol", "dave", "eve"]);
    const [alice, bob, carol, dave, eve] = peers;
    alice.online = dave.online = false;
    await world.run(2_000);
    const written = await talk(world, id, [bob, carol, eve], 4);
    world.reopen(alice);
    // Alice is back but has not caught up: cut from the others, she holds none of it when Dave asks her.
    world.cut = (a, b) => (a === alice || b === alice) && a !== dave && b !== dave;
    comesBack(world, dave, alice);
    const took = await world.until(() => world.texts(dave, id).filter(t => written.includes(t)).length === written.length, 60_000);
    expect(took).toBeLessThanOrEqual(10_000);
    expect(world.texts(dave, id).filter(t => written.includes(t))).toEqual(written);
  });

  it("a member asked of another a moment ago, and reached since, is asked of the first member again", async () => {
    const { world, peers, id } = await meshOf(["alice", "bob", "carol", "dave", "eve"]);
    const [alice, bob, carol, dave, eve] = peers;
    // Dave opens while Eve is away, and asks Alice, the first member it reaches, for her messages; then she is back.
    eve.online = dave.online = false;
    await world.run(2_000);
    comesBack(world, dave, alice);
    await world.run(5_000);
    world.reopen(eve);
    await world.run(5_000);
    expect(world.view(dave, id)!.members.every(m => m.online)).toBe(true);
    // Under a minute later Dave is away, and back: what was asked for Eve then says nothing of what she wrote since.
    dave.online = false;
    await world.run(2_000);
    const written = await talk(world, id, [alice, bob, carol, eve], 3);
    comesBack(world, dave, alice);
    await world.until(() => world.texts(dave, id).filter(t => written.includes(t)).length === written.length, 60_000);
    expect(world.texts(dave, id).filter(t => written.includes(t))).toEqual(written);
  });

  it("an answer of 200 messages that takes fifty seconds: the others are told only once it has come", async () => {
    const { world, peers, id } = await meshOf(["alice", "bob", "carol", "dave", "eve", "frank"]);
    const [alice, bob, carol, dave, eve, frank] = peers;
    dave.online = false;
    await world.run(2_000);
    const written = await talk(world, id, [bob, carol, eve, frank], 50);
    // Four frames a second of the clock: a phone with a long history handles a frame in hundreds of milliseconds.
    world.slowByClock = true;
    comesBack(world, dave, alice);
    await world.until(() => world.texts(dave, id).filter(t => written.includes(t)).length === written.length, 120_000);
    expect(world.texts(dave, id).filter(t => written.includes(t))).toEqual(written);
  });

  it("two members talked while the app was closed and every edge opens at once: their lines alternate as written", async () => {
    const { world, peers, id } = await meshOf(["alice", "bob", "carol", "dave", "eve"]);
    const [alice, , carol, dave] = peers;
    dave.online = false;
    await world.run(2_000);
    // Thirty each: within the last 32 an author hands on of its own, whichever member is told first.
    const written: string[] = [];
    for (let i = 1; i <= 30; i++) for (const p of [alice, carol]) {
      written.push(`${p.name} ${i}`);
      await p.groups.send(id, `${p.name} ${i}`);
      await new Promise(done => setTimeout(done, 2));
      await world.run(300, 300);
    }
    await world.run(3_000);
    await world.restart(dave);
    await world.until(() => world.texts(dave, id).filter(t => written.includes(t)).length === written.length, 120_000);
    await world.run(30_000);
    expect(world.texts(dave, id).filter(t => written.includes(t))).toEqual(written);
  });

  it("one member wrote 200 and every edge opens at once: that member's lines in the order written, the newest last", async () => {
    const { world, peers, id } = await meshOf(["alice", "bob", "carol", "dave", "eve"]);
    const [alice, , , dave] = peers;
    dave.online = false;
    await world.run(2_000);
    const written: string[] = [];
    for (let i = 1; i <= 200; i++) { written.push(`alice ${i}`); await alice.groups.send(id, `alice ${i}`); await world.run(50); }
    // Alice's own answer brings her newest 32; the older ones come from the others, asked for 32 at a time.
    world.slow = (_from, to) => to === dave ? 4 : 0;
    world.reopen(dave);
    await world.until(() => world.texts(dave, id).filter(t => written.includes(t)).length === written.length, 120_000);
    await world.run(1_000);
    expect(world.texts(dave, id).filter(t => written.includes(t))).toEqual(written);
  });

  it("a reply to the newest line, written before the older ones came, stays below the lines it answers", async () => {
    const { world, peers, id } = await meshOf(["alice", "bob", "carol", "dave", "eve"]);
    const [alice, , , dave] = peers;
    dave.online = false;
    await world.run(2_000);
    const written: string[] = [];
    for (let i = 1; i <= 120; i++) { written.push(`alice ${i}`); await alice.groups.send(id, `alice ${i}`); await world.run(50); }
    // Alice is told first: told another first, Dave asks that one for her messages too, and all 120 come at once.
    comesBack(world, dave, alice);
    world.slow = (_from, to) => to === dave ? 4 : 0;
    // Her newest come first: Dave answers the last line as soon as it shows, while the older ones are on their way.
    await world.until(() => world.texts(dave, id).includes("alice 120"), 60_000);
    expect(world.texts(dave, id).filter(t => written.includes(t)).length).toBeLessThan(written.length);
    const reply = "dave: re alice 120";
    await dave.groups.send(id, reply);
    await world.until(() => world.texts(dave, id).filter(t => written.includes(t)).length === written.length, 120_000);
    await world.run(20_000);
    expect(world.texts(dave, id).filter(t => written.includes(t) || t === reply)).toEqual([...written, reply]);
  });

  it("one member wrote 200 and the older ones come 32 at a time: each takes its place as it comes, none moves", async () => {
    const { world, peers, id } = await meshOf(["alice", "bob", "carol", "dave", "eve"]);
    const [alice, , , dave] = peers;
    dave.online = false;
    await world.run(2_000);
    const written: string[] = [];
    for (let i = 1; i <= 200; i++) { written.push(`alice ${i}`); await alice.groups.send(id, `alice ${i}`); await world.run(50); }
    const placeAgain = dave.host.placeAgain!;
    let calls = 0, rows = 0;
    dave.host.placeAgain = async (linkId, ids) => { calls++; rows += ids.length; await placeAgain(linkId, ids); };
    // Alice is told first: told another first, Dave asks that one for her messages too, and all 200 come at once.
    comesBack(world, dave, alice);
    world.slow = (_from, to) => to === dave ? 4 : 0;
    await world.until(() => world.texts(dave, id).filter(t => written.includes(t)).length === written.length, 120_000);
    await world.run(20_000);
    expect(world.texts(dave, id).filter(t => written.includes(t))).toEqual(written);
    // Her newest 32 came first (her own answer), the rest from the others a page at a time, each above the last.
    expect(calls).toBe(0);
    expect(rows).toBe(0);
  });

  it("one member wrote 200 and the older ones come 32 at a time: the lines read in order while they come, the newest last", async () => {
    const { world, peers, id } = await meshOf(["alice", "bob", "carol", "dave", "eve"]);
    const [alice, , , dave] = peers;
    dave.online = false;
    await world.run(2_000);
    const written: string[] = [];
    for (let i = 1; i <= 200; i++) { written.push(`alice ${i}`); await alice.groups.send(id, `alice ${i}`); await world.run(50); }
    world.reopen(dave);
    const unordered: string[] = [];
    for (let s = 1; s <= 120; s++) {
      await world.run(1_000);
      const shown = world.texts(dave, id).filter(t => written.includes(t));
      if (shown.some((t, i) => i > 0 && written.indexOf(t) < written.indexOf(shown[i - 1]))) unordered.push(`+${s} s: ${shown.length} lines, the last "${shown.at(-1)}"`);
      if (shown.length === written.length) break;
    }
    expect(unordered).toEqual([]);
    expect(world.texts(dave, id).filter(t => written.includes(t))).toEqual(written);
  });

  it("a reply to the newest line, sent while the older ones come, stays below it", async () => {
    const { world, peers, id } = await meshOf(["alice", "bob", "carol", "dave", "eve"]);
    const [alice, , , dave] = peers;
    dave.online = false;
    await world.run(2_000);
    const written: string[] = [];
    for (let i = 1; i <= 120; i++) { written.push(`alice ${i}`); await alice.groups.send(id, `alice ${i}`); await world.run(50); }
    world.slow = (_from, to) => to === dave ? 4 : 0;
    world.reopen(dave);
    await world.until(() => world.texts(dave, id).includes("alice 120"), 120_000, 200);
    await dave.groups.send(id, "dave: agreed");
    await world.until(() => world.texts(dave, id).filter(t => written.includes(t)).length === written.length, 120_000);
    await world.run(20_000);
    const texts = world.texts(dave, id);
    expect(texts.filter(t => written.includes(t))).toEqual(written);
    expect(texts.indexOf("dave: agreed")).toBeGreaterThan(texts.indexOf("alice 120"));
  });

  it("someone joined while the member was away: the rows of the epoch before are waited for too, not placed again a page at a time", async () => {
    const { world, peers, id } = await meshOf(["alice", "bob", "carol", "dave"]);
    const [alice, , carol, dave] = peers;
    dave.online = false;
    await world.run(2_000);
    const written: string[] = [];
    const write = async (i: number) => { written.push(`alice ${i}`); await alice.groups.send(id, `alice ${i}`); await world.run(50); };
    for (let i = 1; i <= 190; i++) await write(i);
    // A join is a new epoch: of her newest 32, the first 22 and all the older ones are in the epoch before.
    const erin = world.add("erin");
    await erin.groups.joinByLink(await alice.groups.enableLink(id));
    await world.until(() => world.view(carol, id)?.members.length === 5, 10 * 60_000);
    for (let i = 191; i <= 200; i++) await write(i);
    // Away when Dave is back: she holds nothing of the epoch before, and a turn asking her would delay the rest.
    erin.online = false;
    const placeAgain = dave.host.placeAgain!;
    let calls = 0, rows = 0;
    dave.host.placeAgain = async (linkId, ids) => { calls++; rows += ids.length; await placeAgain(linkId, ids); };
    world.slow = (_from, to) => to === dave ? 4 : 0;
    world.reopen(dave);
    await world.until(() => world.texts(dave, id).filter(t => written.includes(t)).length === written.length, 240_000);
    await world.run(20_000);
    expect(world.texts(dave, id).filter(t => written.includes(t))).toEqual(written);
    // Her newest 32 race a hand-on and the older pages come later: a few moves, each row about once, as without a
    // join. Waiting on her current epoch only, each older one handed on moved her newer rows (500 moves).
    expect(calls).toBeLessThanOrEqual(6);
    expect(rows).toBeLessThanOrEqual(written.length + 32);
  });

  it("what the member asked first writes meanwhile is not its answer: the others are told as soon as that has come", async () => {
    const { world, peers, id } = await meshOf(["alice", "bob", "carol", "dave", "eve"]);
    const [alice, bob, carol, dave, eve] = peers;
    dave.online = false;
    await world.run(2_000);
    const written = await talk(world, id, [alice, bob, carol, eve], 3);
    comesBack(world, dave, alice);
    const back = world.now;
    let toldNext = 0;
    const drop = world.drop!;
    world.drop = (from, to, frame) => { if (from === dave && to !== alice && frame.t === "group-sync") toldNext ||= world.now; return drop(from, to, frame); };
    // From here a message carries the world's time, as the engines' clocks do: Alice writes one every second.
    vi.spyOn(Date, "now").mockImplementation(() => world.now);
    for (let i = 0; i < 12; i++) { await alice.groups.send(id, `alice now ${i}`); await world.run(1_000); }
    expect(world.texts(dave, id).filter(t => written.includes(t))).toEqual(written);
    expect(toldNext - back).toBeGreaterThanOrEqual(MESH_SYNC_HOLD_MS);
    expect(toldNext - back).toBeLessThanOrEqual(5_000);
  });

  it("an app that handles a frame a second: the others wait while the first answer is still queued, and each message comes about once", async () => {
    const { world, peers, id, start } = await slowAppMesh(["alice", "bob", "carol", "dave"], "dave", 1);
    const [alice, , carol, dave] = peers;
    dave.online = false;
    await world.run(2_000);
    for (let i = 0; i < 200; i++) await carol.groups.send(id, `carol ${i}`);
    await world.run(2_000);
    // Every frame to Dave waits its turn behind the others: the members' syncs first, then Alice's answer of all 200.
    const seen = new Set<string>();
    let copies = 0, told = false;
    start((_from, frame) => {
      if (frame.t !== "group-msg") return;
      const key = `${frame.s}:${frame.e}:${frame.n}`;
      if (seen.has(key)) copies++; else seen.add(key);
    });
    const drop = world.drop!;
    world.drop = (from, to, frame) => { if (from === dave && to === alice && frame.t === "group-sync") told = true; return drop(from, to, frame); };
    world.holdEdge = (a, b) => (a === dave || b === dave) && a !== alice && b !== alice && !told;
    await world.restart(dave);
    const has = () => world.texts(dave, id).filter(t => /^carol \d+$/.test(t)).length;
    const took = await world.until(() => has() === 200, 20 * 60_000);
    // Told 1.5 s after the ask, with nothing of Alice's answer handled yet, Bob or Carol sent the same ones again (49).
    expect(copies).toBeLessThanOrEqual(5);
    expect(took).toBeLessThanOrEqual(215_000);
  });
});
