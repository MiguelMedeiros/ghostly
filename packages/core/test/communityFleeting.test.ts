import { describe, expect, it } from "vitest";
import { createIdentity, identityFromSeedB64 } from "../src/identity";
import { toBase64Url } from "../src/bytes";
import {
  COMMUNITY_LIMITS, CommunitySession,
  type CommunityFrame, type CommunitySessionHooks, type CommunityState,
} from "../src/groupCommunity";
import { GROUP_HAVE_FRAME } from "../src/groupFiles";
// covers: groups.community.catch-up, groups.files

/*
 * In a community every member that fetches a photo says so to the group (`group-have`, WISP 503), an application
 * frame. Kept like text, each photo took up to N-1 of the 256 frames a member back from away gets, so the oldest texts
 * never came back (16 members, 200 lines and 6 photos: 160 lines). A frame the host calls fleeting is relayed live
 * and never kept.
 */

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

interface Member { name: string; session: CommunitySession; online: boolean; texts: string[]; apps: Record<string, unknown>[] }

class Net {
  readonly members = new Map<string, Member>();
  private pending: Promise<unknown>[] = [];
  constructor(private readonly withFleeting = true) {}

  private hooks(member: Member): CommunitySessionHooks {
    const deliver = (to: Member | undefined, frame: CommunityFrame) => {
      if (!to || !to.online || !member.online || to === member) return false;
      this.pending.push(to.session.handle(member.session.myKey, clone(frame)));
      return true;
    };
    return {
      save: async () => {},
      broadcast: frame => [...this.members.values()].filter(m => deliver(m, frame)).length,
      direct: (to, frame) => deliver(this.byKey(to), frame),
      addressed: (to, frame) => { deliver(this.byKey(to), frame); },
      message: m => { member.texts.push(m.text); },
      changed: () => {},
      app: m => { member.apps.push(m.frame); },
      // The engine's rule (community.ts): a `group-have` is fleeting.
      ...(this.withFleeting && { fleeting: (frame: Record<string, unknown>) => frame.t === GROUP_HAVE_FRAME }),
    };
  }
  byKey(key: string): Member | undefined { for (const m of this.members.values()) if (m.session.myKey === key) return m; return undefined; }
  private add(name: string, state: CommunityState): Member {
    const member: Member = { name, session: null as unknown as CommunitySession, online: true, texts: [], apps: [] };
    this.members.set(name, member);
    member.session = new CommunitySession(state, this.hooks(member));
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
    for (let i = 0; i < 400; i++) { const batch = this.pending.splice(0); if (!batch.length) break; await Promise.all(batch); }
  }
}

/**
 * A community of `size`; Dave is away while Alice writes `lines` lines and sends `photos` photos among them, each one
 * fetched by every other member online, who then says so (`group-have`, one per holder per photo, as the file desk's
 * tick sends them once a minute). Dave comes back and catches up from Bob.
 */
async function away(size: number, lines: number, photos: number, withFleeting = true) {
  const net = new Net(withFleeting);
  const alice = net.create("Alice");
  const all = [alice];
  for (let i = 1; i < size; i++) all.push(await net.admit(alice, i === 1 ? "Bob" : i === 2 ? "Dave" : `M${i}`));
  await net.settle();
  const [, bob, dave] = all;
  dave.online = false;
  const holders = all.filter(m => m !== alice && m !== dave);
  const every = Math.floor(lines / photos);
  let t = 1_000;
  for (let i = 0, p = 0; i < lines; i++) {
    const sent = await alice.session.sendText(`line ${i}`, "Alice", t++);
    if ("error" in sent) throw new Error(sent.error);
    await net.settle();
    if ((i + 1) % every || p >= photos) continue;
    const photo = await alice.session.sendText(`photo ${p}`, "Alice", t++, [], undefined, undefined, undefined, { name: `p${p}.jpg`, mime: "image/jpeg", size: 1_048_576, d: toBase64Url(new Uint8Array(32).fill(p + 1)) });
    if ("error" in photo) throw new Error(photo.error);
    p++;
    await net.settle();
    for (const holder of holders) {
      const have = await holder.session.sendApp({ t: GROUP_HAVE_FRAME, ids: [photo.id] }, holder.name, t++);
      if ("error" in have) throw new Error(have.error);
    }
    await net.settle();
  }
  dave.online = true;
  for (let i = 0; i < 4; i++) { dave.session.catchUp(bob.session.myKey); await net.settle(); }
  return { all, alice, bob, dave };
}

const linesOf = (m: Member) => m.texts.filter(text => text.startsWith("line "));
const photosOf = (m: Member) => m.texts.filter(text => text.startsWith("photo "));
const havesOf = (m: Member) => m.apps.filter(f => f.t === GROUP_HAVE_FRAME);

describe("a community's group-have is relayed, never kept for whoever was away", { timeout: 120_000 }, () => {
  it("16 members, 200 lines and 6 photos while Dave is away: Dave gets all 200 lines and the 6 photos back", async () => {
    const { all, alice, bob, dave } = await away(16, 200, 6);
    expect(linesOf(dave)).toEqual(Array.from({ length: 200 }, (_, i) => `line ${i}`));
    expect(photosOf(dave)).toHaveLength(6);
    // Only Alice's 206 frames are kept, everywhere: none of the 84 group-have frames.
    for (const m of all.filter(m => m !== dave)) expect(m.session.state.store.length).toBe(206);
    expect(bob.session.state.store.every(f => f.s === alice.session.myKey)).toBe(true);
    // Those online heard them all the same: 13 other holders × 6 photos for Bob, 14 × 6 for Alice.
    expect(havesOf(bob)).toHaveLength(13 * 6);
    expect(havesOf(alice)).toHaveLength(14 * 6);
    expect(havesOf(dave)).toEqual([]);
  });

  it("48 members (a hub's worth), 60 lines and 6 photos: every line comes back", async () => {
    const { dave } = await away(48, 60, 6);
    expect(linesOf(dave)).toHaveLength(60);
    expect(photosOf(dave)).toHaveLength(6);
  });

  it("a fleeting frame is still delivered once, and a frame said after it is kept and caught up", async () => {
    const net = new Net();
    const alice = net.create("Alice");
    const bob = await net.admit(alice, "Bob");
    await net.settle();
    const have = await alice.session.sendApp({ t: GROUP_HAVE_FRAME, ids: ["x"] }, "Alice", 1_000);
    const note = await alice.session.sendApp({ t: "pay-note", x: 1 }, "Alice", 1_001);
    if ("error" in have || "error" in note) throw new Error("not sent");
    await net.settle();
    expect(bob.apps).toEqual([{ t: GROUP_HAVE_FRAME, ids: ["x"] }, { t: "pay-note", x: 1 }]);
    expect(alice.session.state.store).toHaveLength(1);
    expect(bob.session.state.store).toHaveLength(1);
    expect(alice.session.state.unheard ?? []).toEqual([]);
    // Bob asking again is handed nothing new.
    alice.session.catchUp(bob.session.myKey);
    bob.session.catchUp(alice.session.myKey);
    await net.settle();
    expect(bob.apps).toHaveLength(2);
  });

  it("without the hook each group-have is kept like text: the member back from away loses the oldest lines (the bug)", async () => {
    const { dave } = await away(16, 200, 6, false);
    expect(COMMUNITY_LIMITS.store).toBe(256);
    expect(linesOf(dave).length).toBeLessThan(200);
  });
});
