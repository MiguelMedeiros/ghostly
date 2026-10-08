import { afterEach, describe, expect, it, vi } from "vitest";
import { createIdentity, identityFromSeedB64 } from "../src/identity";
import {
  COMMUNITY_LIMITS, CommunitySession,
  type CommunityFrame, type CommunityIncomingMessage, type CommunitySessionHooks, type CommunityState,
} from "../src/groupCommunity";
// covers: groups.catch-up, groups.community.late-joiner

/*
 * A member back in a busy community asks another for what it missed, and the answer is the commits from where it is,
 * their secrets, every stored frame it lacks (the store keeps 256), the link's seed, pending leaves and the picture:
 * 258 frames from a full store, four times the 64 an app before 2026-10-07 holds waiting on one session before it ends
 * it. The answer goes a slice at a time, each once the member's app handled the last, as a private group's does
 * (groupCatchUpPacing.test.ts), with the same frames in the same order.
 */

afterEach(() => { vi.useRealTimers(); });

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

interface Member { name: string; session: CommunitySession; online: boolean }

/** Members on one network: what someone broadcasts reaches every online member (as the hubs' flood does). */
class Net {
  readonly members = new Map<string, Member>();
  private pending: Promise<unknown>[] = [];

  private hooks(name: string): CommunitySessionHooks {
    const deliver = (to: Member | undefined, frame: CommunityFrame) => {
      const me = this.members.get(name)!;
      if (!to || !to.online || !me.online || to === me) return;
      this.pending.push(to.session.handle(me.session.myKey, clone(frame)));
    };
    return {
      save: async () => {},
      broadcast: frame => { for (const m of this.members.values()) deliver(m, frame); },
      direct: (to, frame) => deliver(this.byKey(to), frame),
      addressed: (to, frame) => deliver(this.byKey(to), frame),
      message: () => {},
      changed: () => {},
    };
  }
  byKey(key: string): Member | undefined { for (const m of this.members.values()) if (m.session.myKey === key) return m; return undefined; }
  private add(name: string, state: CommunityState): Member {
    const member: Member = { name, session: null as unknown as CommunitySession, online: true };
    this.members.set(name, member);
    member.session = new CommunitySession(state, this.hooks(name));
    return member;
  }
  create(name: string): Member { return this.add(name, CommunitySession.create("Ghosts")); }
  async admit(by: Member, name: string): Promise<Member> {
    const seedB64 = createIdentity().seedB64;
    const frames = await by.session.admit(identityFromSeedB64(seedB64).pubKeyZ32);
    await this.settle();
    const joined = CommunitySession.join({ g: by.session.id, host: by.session.entryKey }, clone(frames.slice(0, -1)), clone(frames[frames.length - 1]), seedB64);
    if ("error" in joined) throw new Error(joined.error);
    return this.add(name, joined.state);
  }
  async settle(): Promise<void> {
    for (let i = 0; i < 200; i++) { const batch = this.pending.splice(0); if (!batch.length) break; await Promise.all(batch); }
  }
}

/**
 * Alice, Bob, Carol and Dave. Bob's app is closed while the three others say `messages` things (more than the store
 * keeps fills it) and, with `commits`, Alice lets that many people in and removes the last (a fresh secret).
 */
async function awayCommunity(messages: number, commits = 0) {
  const net = new Net();
  const alice = net.create("Alice");
  const bob = await net.admit(alice, "Bob");
  const carol = await net.admit(alice, "Carol");
  const dave = await net.admit(carol, "Dave");
  await net.settle();
  bob.online = false;
  let last: Member | undefined;
  for (let i = 0; i < commits; i++) last = await net.admit(alice, `N${i}`);
  if (last) { await alice.session.remove(last.session.myKey); await net.settle(); }
  const speakers = [alice, carol, dave];
  for (let i = 0; i < messages; i++) {
    const speaker = speakers[i % speakers.length];
    const sent = await speaker.session.sendText(`${speaker.name} ${i}`, speaker.name, 1_000 + i);
    if ("error" in sent) throw new Error(sent.error);
    await net.settle();
  }
  return { alice, bob, sync: clone(bob.session.syncFrame()), bobState: clone(bob.session.state) };
}

/**
 * Alice's answer to Bob's sync, from a copy of her state: `sent` is what went on Bob's edge, which takes every frame
 * while `edge.open`. `extra`: more hooks (or another `direct`).
 */
async function answer(alice: Member, bobKey: string, sync: unknown, extra: Partial<CommunitySessionHooks> = {}) {
  const sent: CommunityFrame[] = [], edge = { open: true };
  const session = new CommunitySession(clone(alice.session.state), {
    save: async () => {}, broadcast: () => 0, addressed: () => {}, message: () => {}, changed: () => {},
    direct: (_to, frame) => { if (!edge.open) return false; sent.push(frame); return true; },
    ...extra,
  });
  await session.handle(bobKey, clone(sync));
  return { session, sent, edge };
}

/** A frame as the wire says it, without what is sealed afresh at each answer (secrets sealed to Bob). */
function said(frame: CommunityFrame): string {
  const f = frame as unknown as Record<string, unknown> & { commit?: { sig: string }; secrets?: { h: string }[] };
  return `${f.t}:${f.commit?.sig ?? f.sig ?? f.h ?? f.secrets?.map(s => s.h).join(",") ?? f.x ?? f.s ?? ""}`;
}
const kinds = (frames: CommunityFrame[]) => frames.reduce<Record<string, number>>((n, f) => ({ ...n, [f.t]: (n[f.t] ?? 0) + 1 }), {});
/** Where the last commit or secret is, and the first message: the first before the second. */
function needsFirst(types: string[]): [number, number] {
  return [Math.max(types.lastIndexOf("group-commit"), types.lastIndexOf("group-secret"), types.lastIndexOf("group-secrets")), types.indexOf("group-msg")];
}

const slice = COMMUNITY_LIMITS.catchUpSlice;

describe("a community member's catch-up answer goes a slice at a time", { timeout: 120_000 }, () => {
  it("a member back after the store filled is handed 258 frames in one answer; with commits, more (measured)", async () => {
    const full = await awayCommunity(300);
    const one = await answer(full.alice, full.bob.session.myKey, full.sync);
    // The 256 frames the store keeps, the link's seed and Alice's question back.
    expect(full.alice.session.state.store).toHaveLength(COMMUNITY_LIMITS.store);
    expect(kinds(one.sent)).toEqual({ "group-msg": 256, "group-entry": 1, "group-sync": 1 });
    expect(one.sent).toHaveLength(258);
    // Twenty people let in and one removed while Bob was away: their commits and secrets come first.
    const busy = await awayCommunity(300, 20);
    const two = await answer(busy.alice, busy.bob.session.myKey, busy.sync);
    expect(kinds(two.sent)).toEqual({ "group-commit": 21, "group-secret": 1, "group-secrets": 1, "group-msg": 256, "group-entry": 1, "group-sync": 1 });
    expect(two.sent).toHaveLength(281);
    const [lastNeeded, firstMessage] = needsFirst(two.sent.map(f => f.t));
    expect(lastNeeded).toBeLessThan(firstMessage);
  });

  it("never more than two slices go before the member's app handled any (2026-10-07)", async () => {
    const { alice, bob, sync } = await awayCommunity(300);
    // Bob's app has handled nothing yet: nothing resolves.
    const { sent } = await answer(alice, bob.session.myKey, sync, { handled: () => new Promise<boolean>(() => {}) });
    await sleep(20);
    expect(sent.length).toBeLessThanOrEqual(2 * slice);
    expect(sent).toHaveLength(2 * 16);
  });

  it("each slice of 16 goes once the member's app handled the one before the last, in the answer's order; a newer answer takes the place of the rest", async () => {
    const { alice, bob, sync } = await awayCommunity(300, 20);
    // The answer as it went before: all at once.
    const whole = (await answer(alice, bob.session.myKey, sync)).sent.map(said);
    let now = Date.now();
    const waits: (() => void)[] = [];
    const { session, sent } = await answer(alice, bob.session.myKey, sync, {
      clock: () => now,
      handled: () => new Promise<boolean>(resolve => waits.push(() => resolve(true))),
    });
    // Two slices go with the answer; the next waits for Bob's app to have handled the first.
    expect(sent.map(said)).toEqual(whole.slice(0, 2 * slice));
    expect(waits).toHaveLength(2);
    await sleep(20);
    expect(sent).toHaveLength(2 * slice);
    waits.shift()!();
    await vi.waitFor(() => expect(sent).toHaveLength(3 * slice));
    expect(sent.map(said)).toEqual(whole.slice(0, 3 * slice));
    // Bob's sync again a while later (its edge opened again): the new answer takes the place of what is left of the first.
    now += 10_000;
    await session.handle(bob.session.myKey, clone(sync));
    expect(sent).toHaveLength(3 * slice);
    while (sent.length < 3 * slice + whole.length) {
      await vi.waitFor(() => expect(waits.length).toBeGreaterThan(0));
      waits.shift()!();
      await sleep(0);
    }
    expect(sent.map(said)).toEqual([...whole.slice(0, 3 * slice), ...whole]);
    // Commits and secrets before the frames that need them, as before.
    const [lastNeeded, firstMessage] = needsFirst(whole.map(w => w.split(":")[0]));
    expect(lastNeeded).toBeLessThan(firstMessage);
    // Nothing is asked after the last slice: the one before it is the only question left.
    await sleep(20);
    expect(waits.length).toBeLessThanOrEqual(1);
  });

  it("an app that cannot say waits a pause between slices; an edge that takes no frame ends the answer", async () => {
    const { alice, bob, sync } = await awayCommunity(300);
    vi.useFakeTimers();
    const { sent, edge } = await answer(alice, bob.session.myKey, sync, { handled: async () => false });
    expect(sent).toHaveLength(2 * slice);
    await vi.advanceTimersByTimeAsync(COMMUNITY_LIMITS.catchUpPauseMs - 1);
    expect(sent).toHaveLength(2 * slice);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toHaveLength(3 * slice);
    edge.open = false;
    await vi.advanceTimersByTimeAsync(20 * COMMUNITY_LIMITS.catchUpPauseMs);
    expect(sent).toHaveLength(3 * slice);
  });

  it("a member that comes back gets everything it would have all at once, and nothing waits", async () => {
    const { alice, bob, sync, bobState } = await awayCommunity(300, 20);
    // Bob's app takes each frame as it comes, and says it handled them once it did.
    const backAt = async (paced: boolean) => {
      const got: CommunityIncomingMessage[] = [];
      const receiver = new CommunitySession(clone(bobState), {
        save: async () => {}, broadcast: () => 0, direct: () => {}, addressed: () => {}, changed: () => {},
        message: m => { got.push(m); },
      });
      let handling: Promise<unknown> = Promise.resolve(), sentCount = 0, mostWaiting = 0, done = 0;
      await answer(alice, bob.session.myKey, sync, {
        direct: (_to, frame) => {
          mostWaiting = Math.max(mostWaiting, ++sentCount - done);
          handling = Promise.all([handling, receiver.handle(alice.session.myKey, clone(frame)).then(() => { done++; })]);
          return true;
        },
        ...(paced && { handled: () => handling.then(() => true) }),
      });
      await vi.waitFor(() => expect(done).toBe(sentCount));
      await sleep(50);
      await handling;
      return { got, receiver, sentCount, mostWaiting };
    };
    const atOnce = await backAt(false), paced = await backAt(true);
    expect(paced.sentCount).toBe(281);
    expect(paced.got.map(m => m.id).sort()).toEqual(atOnce.got.map(m => m.id).sort());
    expect(paced.got).toHaveLength(256);
    expect(paced.receiver.epoch).toBe(alice.session.epoch);
    expect(paced.receiver.needsCatchUp).toBe(false);
    expect(paced.mostWaiting).toBeLessThanOrEqual(2 * slice);
    expect(atOnce.mostWaiting).toBeGreaterThan(64);
  });
});
