import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredMessage } from "../src/shared/types";
import type { GroupMarks } from "../src/engine/groups";
// covers: groups.catch-up

/**
 * A group's newest line deleted for everyone puts its unread, "@" and list marks back (`unmark`): read a page at a time
 * from the newest back (`db.getMessagePage`), where the whole history cost ~20 ms per 1,000 rows on each member's daemon
 * for every delete. The marks are the ones the whole history gives.
 */
let db: typeof import("../src/engine/db").db;
let groups: typeof import("../src/engine/groups");

beforeEach(async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  vi.resetModules();
  ({ db } = await import("../src/engine/db"));
  groups = await import("../src/engine/groups");
}, 60_000);
afterEach(() => vi.unstubAllGlobals());

const GROUP = "g1", LINK = `group:${GROUP}`;
const fresh = (): GroupMarks => ({ lastMessageAt: new Map(), lastPeerMessageAt: new Map(), lastMentionAt: new Map(), by: new Map() });
const copy = (m: GroupMarks): GroupMarks => ({ lastMessageAt: new Map(m.lastMessageAt), lastPeerMessageAt: new Map(m.lastPeerMessageAt), lastMentionAt: new Map(m.lastMentionAt), by: new Map(m.by) });
/** A seeded random, so a failure replays. */
const random = (seed: number) => () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;

describe("a group's newest line deleted for everyone", { timeout: 120_000 }, () => {
  it("reads a page, not the whole history: before and after at 1,500 rows", async () => {
    const rows: StoredMessage[] = Array.from({ length: 1_500 }, (_, i) => ({ linkId: LINK, id: `m${String(i).padStart(5, "0")}`, text: `line ${i}`, sender: i % 3 ? "bob" : "me", timestamp: 1_000 + i, via: "datalink" }));
    for (const m of rows) await db.putMessage(m);
    const timed = async (store: Parameters<typeof groups.unmark>[3]) => {
      const spent: number[] = [];
      for (let n = 0; n < 15; n++) {
        const marks = fresh();
        groups.loadMarks(marks, { id: GROUP }, rows);
        const removed = rows[rows.length - 1]!;
        const started = performance.now();
        await groups.unmark(marks, undefined, GROUP, store, removed);
        spent.push(performance.now() - started);
        expect(marks.lastMessageAt.get(GROUP)).toBe(rows[rows.length - 2]!.timestamp);
      }
      return spent.sort((a, b) => a - b)[7]!;
    };
    // Without pages, `unmark` reads the whole history, as it did before.
    const whole = await timed({ getMessages: linkId => db.getMessages(linkId) });
    const paged = await timed(db);
    console.log(`UNMARK 1,500 rows: whole history ${whole.toFixed(2)} ms, pages ${paged.toFixed(2)} ms (median of 15)`);
    expect(paged).toBeLessThan(whole);
  });

  it("a mark with none older to go back to costs about the whole history, not 5 times it", async () => {
    // The group's only "@" taken back: no older mention is there, so every row is read. Page after page from the newest
    // back cost 5 times the whole history at once (326 ms against 62 at 20,000 rows on the CLI's store).
    const rows: StoredMessage[] = Array.from({ length: 5_000 }, (_, i) => ({ linkId: LINK, id: `m${String(i).padStart(5, "0")}`, text: `line ${i}`, sender: i % 3 ? "bob" : "me", timestamp: 1_000 + i, via: "datalink", ...(i === 4_999 && { mentioned: true }) }));
    await Promise.all(rows.map(m => db.putMessage(m)));
    const timed = async (store: Parameters<typeof groups.unmark>[3]) => {
      const spent: number[] = [];
      for (let n = 0; n < 5; n++) {
        const marks = fresh();
        groups.loadMarks(marks, { id: GROUP }, rows);
        const started = performance.now();
        await groups.unmark(marks, undefined, GROUP, store, rows[4_999]!, true);
        spent.push(performance.now() - started);
        expect(marks.lastMentionAt.has(GROUP)).toBe(false);
      }
      return spent.sort((a, b) => a - b)[2]!;
    };
    const whole = await timed({ getMessages: linkId => db.getMessages(linkId) });
    const paged = await timed(db);
    console.log(`UNMARK only mention, 5,000 rows: whole history ${whole.toFixed(2)} ms, pages ${paged.toFixed(2)} ms (median of 5)`);
    expect(paged).toBeLessThan(whole * 2);
  });

  it("puts back the marks the whole history says, for any line deleted (seeded fuzz)", async () => {
    const next = random(11);
    const rows: StoredMessage[] = [];
    for (let i = 0; i < 400; i++) {
      const r = next();
      rows.push({
        linkId: LINK, id: `m${Math.floor(next() * 1e6)}-${i}`, text: `line ${i}`, sender: next() < 0.6 ? "me" : "bob",
        // Several lines share a time: ties go by id, as in `getMessages`.
        timestamp: 1_000 + Math.floor(i / 3), via: "datalink",
        ...(r < 0.2 && { event: { kind: "joined" } as unknown as StoredMessage["event"] }), ...(r > 0.97 && { mentioned: true }),
      });
    }
    for (const m of rows) await db.putMessage(m);
    const history = await db.getMessages(LINK);
    const marks = fresh();
    groups.loadMarks(marks, { id: GROUP }, history);
    for (let n = 0; n < 60; n++) {
      // Each mark's own line, mostly; now and then any line (`unmark` has nothing to do for it).
      const by = marks.by.get(GROUP)!;
      const pick = [by.last, by.peer, by.mention, history[Math.floor(next() * history.length)]!.id][Math.floor(next() * 4)];
      const removed = history.find(m => m.id === pick) ?? history[history.length - 1]!;
      const mentionOnly = next() < 0.2;
      const viaPages = copy(marks), viaWhole = copy(marks);
      if (!mentionOnly) await db.deleteMessage(LINK, removed.id);
      const group = { came: { peer: 5, mention: 6 } }, wholeGroup = { came: { peer: 5, mention: 6 } };
      const saved = await groups.unmark(viaPages, group, GROUP, db, removed, mentionOnly);
      const wholeSaved = await groups.unmark(viaWhole, wholeGroup, GROUP, { getMessages: linkId => db.getMessages(linkId) }, removed, mentionOnly);
      expect(viaPages).toEqual(viaWhole);
      expect([saved, group]).toEqual([wholeSaved, wholeGroup]);
      if (!mentionOnly) history.splice(history.indexOf(removed), 1);
      Object.assign(marks, viaPages);
      if (!history.length) break;
    }
  });
});
