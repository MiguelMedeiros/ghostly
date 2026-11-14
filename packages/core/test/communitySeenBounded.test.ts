import { describe, expect, it } from "vitest";
import { createIdentity, identityFromSeedB64 } from "../src/identity";
import {
  COMMUNITY_LIMITS, CommunitySession,
  type CommunityFrame, type CommunityMessageFrame, type CommunitySessionHooks, type CommunityState,
} from "../src/groupCommunity";
// covers: groups.community.leave

/*
 * A community member keeps, per sender and per epoch it heard that sender in, the highest number and the window below
 * it (`state.seen`), for 64 epochs, and the record holding them is written at every message. Old epochs went only for
 * the sender of the frame being marked, so a member who left, or just went quiet, kept every entry for the life of the
 * group: 15 of 15 leavers still held theirs 70 commits later (agents#2904). Every sender's now go once the branch
 * moves past them, and what the window holds (a leaver's included) is deduplicated as before.
 */

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

interface Member { name: string; session: CommunitySession; online: boolean; texts: string[] }

/** Members on one network: what someone broadcasts reaches every online member (as the hubs' flood does). */
class Net {
  readonly members = new Map<string, Member>();
  /** Every message frame said, by its author's name, as it went out. */
  readonly said = new Map<string, CommunityMessageFrame[]>();
  private pending: Promise<unknown>[] = [];

  private hooks(name: string): CommunitySessionHooks {
    const deliver = (to: Member | undefined, frame: CommunityFrame) => {
      const me = this.members.get(name)!;
      if (!to || !to.online || !me.online || to === me) return;
      this.pending.push(to.session.handle(me.session.myKey, clone(frame)));
    };
    return {
      save: async () => {},
      broadcast: frame => {
        if (frame.t === "group-msg" && (frame as CommunityMessageFrame).s === this.members.get(name)!.session.myKey) {
          const list = this.said.get(name) ?? [];
          list.push(clone(frame as CommunityMessageFrame));
          this.said.set(name, list);
        }
        for (const m of this.members.values()) deliver(m, frame);
      },
      direct: (to, frame) => deliver(this.byKey(to), frame),
      addressed: (to, frame) => deliver(this.byKey(to), frame),
      message: m => { this.members.get(name)!.texts.push(m.text); },
      changed: () => {},
    };
  }
  byKey(key: string): Member | undefined { for (const m of this.members.values()) if (m.session.myKey === key) return m; return undefined; }
  private add(name: string, state: CommunityState): Member {
    const member: Member = { name, session: null as unknown as CommunitySession, online: true, texts: [] };
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
  /** Someone let in whose app never opens: only a commit (a new epoch) for everyone else. */
  async join(by: Member): Promise<void> {
    await by.session.admit(createIdentity().pubKeyZ32);
    await this.settle();
  }
  async say(m: Member, text: string): Promise<void> {
    const sent = await m.session.sendText(text, m.name);
    if ("error" in sent) throw new Error(sent.error);
    await this.settle();
  }
  async settle(): Promise<void> {
    for (let i = 0; i < 400; i++) {
      const batch = this.pending.splice(0);
      if (!batch.length) { await sleep(0); if (!this.pending.length) break; continue; }
      await Promise.all(batch);
    }
  }
}

/** The epochs a member's seen marks name, per sender, and how many there are. */
function seenOf(state: CommunityState) {
  const epochs = Object.values(state.seen).flatMap(bySender => Object.keys(bySender).map(k => Number(k.split(":")[0])));
  return { senders: Object.keys(state.seen).length, entries: epochs.length, oldest: Math.min(...epochs), bytes: JSON.stringify(state.seen).length };
}

async function community(size: number) {
  const net = new Net();
  const alice = net.create("Alice");
  const members = [alice];
  for (let i = 1; i < size; i++) members.push(await net.admit(alice, `M${i}`));
  return { net, alice, observer: members[size - 1], members };
}

describe("a community's seen marks", { timeout: 300_000 }, () => {
  it("drop those who left once the window is past their epochs, and dedupe a leaver's lines inside it as before (P1)", async () => {
    // 40 members, 30 of them speak 10 lines; 15 of the speakers leave; then 70 people are let in (70 commits).
    const { net, alice, observer, members } = await community(40);
    const speakers = members.slice(1, 31), leavers = speakers.slice(0, 15), stayers = speakers.slice(15);
    for (let line = 0; line < 10; line++) for (const s of speakers) await net.say(s, `${s.name} ${line}`);
    // The observer is away for one leaver's last line, which the hub that commits the leave heard.
    const late = leavers[0];
    observer.online = false;
    await net.say(late, `${late.name} late`);
    observer.online = true;
    for (const l of leavers) { await l.session.leave(); await net.settle(); }
    await alice.session.commitPendingLeaves();
    await net.settle();
    for (const l of leavers) expect(observer.session.roster.some(([k]) => k === l.session.myKey)).toBe(false);
    const leaveEpoch = observer.session.epoch;
    const shown = () => observer.texts.length;

    // Inside the window: the line it missed is taken up to the leave's mark, once; a line it had is not taken again.
    const missed = net.said.get(late.name)!.at(-1)!, had = net.said.get(late.name)![0];
    const before = shown();
    await observer.session.handle(alice.session.myKey, clone(missed));
    expect(observer.texts.slice(before)).toEqual([`${late.name} late`]);
    await observer.session.handle(alice.session.myKey, clone(missed));
    await observer.session.handle(alice.session.myKey, clone(had));
    expect(shown()).toBe(before + 1);
    // A current member's line said again is dropped too.
    const stayerLine = net.said.get(stayers[0].name)![3];
    await observer.session.handle(alice.session.myKey, clone(stayerLine));
    expect(shown()).toBe(before + 1);

    // A few commits on, still inside the window: every leaver's marks are kept, and its lines still deduplicated.
    for (let i = 0; i < 10; i++) await net.join(alice);
    for (const l of leavers) expect(observer.session.state.seen[l.session.myKey]).toBeDefined();
    await observer.session.handle(alice.session.myKey, clone(missed));
    await observer.session.handle(alice.session.myKey, clone(stayerLine));
    expect(shown()).toBe(before + 1);

    // 70 commits after the leaves: past the window, nothing of the leavers is kept, nor of the speakers gone quiet.
    for (let i = 10; i < 70; i++) await net.join(alice);
    const epoch = observer.session.epoch;
    expect(epoch - leaveEpoch).toBe(70);
    const kept = leavers.filter(l => observer.session.state.seen[l.session.myKey]);
    expect(kept.map(l => l.name)).toEqual([]);
    expect(stayers.filter(s => observer.session.state.seen[s.session.myKey]).map(s => s.name)).toEqual([]);
    expect(observer.session.state.seen).toEqual({});
    // And a leaver's line said again past the window is not shown again.
    await observer.session.handle(alice.session.myKey, clone(missed));
    await observer.session.handle(alice.session.myKey, clone(had));
    await net.settle();
    expect(shown()).toBe(before + 1);

    // Those who speak again are marked as before.
    await net.say(stayers[0], "back");
    const seen = seenOf(observer.session.state);
    expect(seen).toMatchObject({ senders: 1, entries: 1, oldest: epoch });
  });

  it("stay within the window's epochs in a busy community where most members go quiet (P1b)", async () => {
    // 50 members; for 5 rounds all 48 speakers write a line, then only 8 of them; someone joins after each round.
    const { net, alice, observer, members } = await community(50);
    const speakers = members.slice(1, 49), busy = speakers.slice(0, 8);
    const sizes: { round: number; epoch: number; entries: number; bytes: number; oldest: number }[] = [];
    for (let round = 1; round <= 70; round++) {
      for (const s of round <= 5 ? speakers : busy) await net.say(s, `${s.name} ${round}`);
      await net.join(alice);
      sizes.push({ round, epoch: observer.session.epoch, ...seenOf(observer.session.state) });
    }
    const last = sizes.at(-1)!;
    // Every entry is of an epoch a frame may still be taken in, and they are the busy speakers' only.
    expect(last.oldest).toBeGreaterThanOrEqual(last.epoch - COMMUNITY_LIMITS.window);
    expect(Object.keys(observer.session.state.seen).sort()).toEqual(busy.map(s => s.session.myKey).sort());
    expect(last.entries).toBeLessThanOrEqual(busy.length * (COMMUNITY_LIMITS.window + 1));
    // Past the window it grows no more with epochs.
    expect(last.bytes).toBeLessThanOrEqual(sizes[sizes.length - 7].bytes);
    // A busy speaker's line of 30 rounds ago, said again, is still dropped.
    const shown = observer.texts.length;
    await observer.session.handle(alice.session.myKey, clone(net.said.get(busy[0].name)![35]));
    expect(observer.texts.length).toBe(shown);
  });
});
