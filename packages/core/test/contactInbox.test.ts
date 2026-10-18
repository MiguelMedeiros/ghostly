import { describe, expect, it } from "vitest";
import { createIdentity } from "../src/identity";
import { createContactLink } from "../src/contactLink";
import { contactDay, makeStamp, seenEntry, STAMP_BITS_DEFAULT, STAMP_BITS_MAX, type ContactKnock } from "../src/contactRecords";
import {
  clearMissed, endedRequests, inboxRecord, newInbox, planKnocks, settleRequest, takeRequest, turnOff,
  FLOOD_PER_DAY, MAX_DONE, MAX_MISSED, MAX_WAITING, NEW_PER_HOUR, REOPEN_BELOW, type InboxState,
} from "../src/contactInbox";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 16, 12);
const WEEK = 7 * 24 * HOUR;
const { linkKeyZ32: L } = createContactLink();
/** A low difficulty, so the tests make stamps at once; the rules do not depend on it. */
const BITS = 4;
const inbox = (over: Partial<InboxState> = {}): InboxState => ({ ...newInbox(NOW), bits: BITS, ...over });
const knock = (key = createIdentity().pubKeyZ32, at = NOW, bits = BITS): ContactKnock => ({ key, day: contactDay(at), stamp: makeStamp(L, key, contactDay(at), bits) });
/** Take every key a plan reads, as if each request read well. */
const takeAll = (state: InboxState, keys: string[], at = NOW) => keys.reduce((s, key) => takeRequest(L, s, key, at + WEEK, at), state);

describe("a contact link's limits (WISP 8xx)", () => {
  it("reads a new key once, puts it in Requests and in seen", () => {
    const k = knock();
    const plan = planKnocks(L, inbox(), [k, k], NOW);
    expect(plan.read).toEqual([k.key]);
    const taken = takeRequest(L, plan.inbox, k.key, NOW + WEEK, NOW);
    expect(taken.waiting).toEqual([{ key: k.key, expires: NOW + WEEK }]);
    expect(inboxRecord(taken, NOW).seen).toEqual([seenEntry(L, k.key)]);
  });

  it("skips a knock whose stamp fails, or was made the day before yesterday", () => {
    const k = knock();
    expect(planKnocks(L, inbox({ bits: 30 }), [k], NOW).read).toEqual([]);
    expect(planKnocks(L, inbox(), [knock(undefined, NOW - 2 * 24 * HOUR)], NOW).read).toEqual([]);
  });

  it("takes 12 new requests an hour; the 13th waits for the next hour", () => {
    const knocks = Array.from({ length: NEW_PER_HOUR + 1 }, () => knock());
    const first = planKnocks(L, inbox(), knocks, NOW);
    expect(first.read).toEqual(knocks.slice(0, NEW_PER_HOUR).map(k => k.key));
    const state = takeAll(first.inbox, first.read);
    expect(planKnocks(L, state, knocks, NOW + 10 * 60_000).read).toEqual([]);
    const later = NOW + HOUR;
    expect(planKnocks(L, state, [knock(knocks[NEW_PER_HOUR].key, later)], later).read).toEqual([knocks[NEW_PER_HOUR].key]);
  });

  it("reads one asker key's request once an hour, taken or not", () => {
    const k = knock();
    const first = planKnocks(L, inbox(), [k], NOW);
    // Its request was missing: not read again before the hour is out.
    expect(planKnocks(L, first.inbox, [k], NOW + HOUR - 1).read).toEqual([]);
    expect(planKnocks(L, first.inbox, [k], NOW + HOUR).read).toEqual([k.key]);
  });

  it("counts every request read in the hour, taken or not: fresh keys with no request do not read past 12 an hour", () => {
    let state = inbox();
    let reads = 0;
    // A poll every 15 s for an hour, each with 12 fresh keys that published nothing.
    for (let at = NOW; at < NOW + HOUR; at += 15_000) {
      const plan = planKnocks(L, state, Array.from({ length: NEW_PER_HOUR }, () => knock(undefined, at)), at);
      reads += plan.read.length;
      state = plan.inbox;
    }
    expect(reads).toBe(NEW_PER_HOUR);
    const later = NOW + HOUR;
    const k = knock(undefined, later);
    expect(planKnocks(L, state, [k], later).read).toEqual([k.key]);
  });

  it("goes busy at 32 waiting, counts who tried without reading them, and opens again below 24", () => {
    let state = inbox();
    for (let hour = 0; state.waiting.length < MAX_WAITING; hour++) {
      const at = NOW + hour * HOUR;
      const plan = planKnocks(L, state, Array.from({ length: NEW_PER_HOUR }, () => knock(undefined, at)), at);
      state = takeAll(plan.inbox, plan.read.slice(0, MAX_WAITING - state.waiting.length), at);
    }
    expect(state.state).toBe("busy");
    expect(inboxRecord(state, NOW).state).toBe("busy");
    const at = NOW + 3 * HOUR;
    const tried = [knock(undefined, at), knock(undefined, at)];
    const busy = planKnocks(L, state, [...tried, tried[0]], at);
    expect(busy.read).toEqual([]);
    expect(busy.inbox.missed).toEqual(tried.map(k => k.key));
    expect(clearMissed(busy.inbox).missed).toEqual([]);
    let settled = busy.inbox;
    for (const w of busy.inbox.waiting.slice(0, MAX_WAITING - REOPEN_BELOW)) settled = settleRequest(settled, w.key);
    expect(settled.state).toBe("busy");
    settled = settleRequest(settled, settled.waiting[0].key);
    expect(settled.state).toBe("open");
  });

  it("never takes past 32 waiting, even when the hour has room", () => {
    const waiting = Array.from({ length: MAX_WAITING - 1 }, (_, i) => ({ key: `w${i}`, expires: NOW + WEEK }));
    const knocks = Array.from({ length: 5 }, () => knock());
    const plan = planKnocks(L, inbox({ waiting }), knocks, NOW);
    expect(plan.read).toEqual([knocks[0].key]);
    const full = takeAll(plan.inbox, knocks.map(k => k.key));
    expect(full.waiting).toHaveLength(MAX_WAITING);
    expect(full.state).toBe("busy");
  });

  it("a request that ended unanswered may ask again; accepted and declined keys are kept, the latest 4096", () => {
    const k = knock();
    const ended = settleRequest(takeRequest(L, inbox(), k.key, NOW + HOUR, NOW), k.key, "ended");
    expect(ended.done).toEqual([]);
    const later = NOW + 2 * HOUR;
    expect(planKnocks(L, ended, [knock(k.key, later)], later).read).toEqual([k.key]);
    const many = inbox({ done: Array.from({ length: MAX_DONE }, (_, i) => `d${i}`), waiting: [{ key: "last", expires: NOW + WEEK }] });
    const settled = settleRequest(many, "last");
    expect(settled.done).toHaveLength(MAX_DONE);
    expect(settled.done.at(-1)).toBe("last");
    expect(settled.done[0]).toBe("d1");
  });

  it("keeps at most 256 who tried while busy", () => {
    const state = inbox({ state: "busy", missed: Array.from({ length: MAX_MISSED }, (_, i) => `k${i}`) });
    expect(planKnocks(L, state, [knock()], NOW).inbox.missed).toHaveLength(MAX_MISSED);
  });

  it("never reads a settled key again, and puts its seen entry back when it dropped off, without a read", () => {
    const k = knock();
    let state = takeAll(planKnocks(L, inbox(), [k], NOW).inbox, [k.key]);
    state = settleRequest(state, k.key);
    expect(state.done).toEqual([k.key]);
    expect(state.waiting).toEqual([]);
    // Declined: seen is unchanged, so the requester cannot tell.
    expect(inboxRecord(state, NOW).seen).toEqual([seenEntry(L, k.key)]);
    const later = NOW + 8 * 24 * HOUR;
    expect(inboxRecord(state, later).seen).toEqual([]);
    const again = planKnocks(L, { ...state, day: contactDay(later) }, [knock(k.key, later)], later);
    expect(again.read).toEqual([]);
    expect(again.publish).toBe(true);
    expect(inboxRecord(again.inbox, later).seen).toEqual([seenEntry(L, k.key)]);
    // Already at the front: nothing to publish.
    expect(planKnocks(L, again.inbox, [knock(k.key, later)], later).publish).toBe(false);
  });

  it("ends what waited past its time", () => {
    const k = knock();
    const state = takeRequest(L, inbox(), k.key, NOW + HOUR, NOW);
    expect(endedRequests(state, NOW + HOUR - 1)).toEqual([]);
    expect(endedRequests(state, NOW + HOUR)).toEqual([k.key]);
  });

  it("asks 2 more bits the day after a flood, up to 24, and steps back down by 2 a day", () => {
    const flooded = { ...newInbox(NOW), overflow: Array.from({ length: FLOOD_PER_DAY + 1 }, (_, i) => `k${i}`) };
    const tomorrow = NOW + 24 * HOUR;
    const raised = planKnocks(L, flooded, [], tomorrow);
    expect(raised.inbox.bits).toBe(STAMP_BITS_DEFAULT + 2);
    expect(raised.publish).toBe(true);
    expect(planKnocks(L, { ...flooded, bits: STAMP_BITS_MAX }, [], tomorrow).inbox.bits).toBe(STAMP_BITS_MAX);
    expect(planKnocks(L, { ...newInbox(NOW), bits: 22 }, [], tomorrow).inbox.bits).toBe(20);
    expect(planKnocks(L, newInbox(NOW), [], tomorrow).inbox.bits).toBe(STAMP_BITS_DEFAULT);
  });

  it.each([
    ["busy", false],
    ["open with the hour full", true],
  ])("counts a knock it could not take once a day, though it is seen at every poll, while %s", (_name, hourFull) => {
    const tomorrow = NOW + 24 * HOUR;
    const start = hourFull ? inbox() : inbox({ state: "busy", waiting: Array.from({ length: MAX_WAITING }, (_, i) => ({ key: `w${i}`, expires: NOW + WEEK })) });
    const poll = (state: InboxState, knocks: ContactKnock[]) => {
      // Every 5 minutes until the day ends, the hour kept full when open.
      for (let at = NOW; contactDay(at) === contactDay(NOW); at += 5 * 60_000) {
        state = planKnocks(L, hourFull ? { ...state, taken: Array.from({ length: NEW_PER_HOUR }, () => at) } : state, knocks, at).inbox;
      }
      return state;
    };
    const few = poll(start, Array.from({ length: 3 }, () => knock()));
    expect(few.overflow).toHaveLength(3);
    // Not flooded: the bits step back towards the default, not 2 up.
    expect(planKnocks(L, few, [], tomorrow).inbox.bits).toBe(STAMP_BITS_DEFAULT);
    const many = poll(start,Array.from({ length: FLOOD_PER_DAY + 1 }, () => knock()));
    expect(planKnocks(L, many, [], tomorrow).inbox.bits).toBe(BITS + 2);
  });

  it("a link turned off reads nothing and takes nothing", () => {
    const k = knock();
    const off = turnOff(inbox());
    expect(planKnocks(L, off, [k], NOW).read).toEqual([]);
    expect(takeRequest(L, off, k.key, NOW + WEEK, NOW)).toBe(off);
    expect(inboxRecord(off, NOW).state).toBe("off");
  });
});
