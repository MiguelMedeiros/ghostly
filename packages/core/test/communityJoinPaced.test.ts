import { describe, expect, it } from "vitest";
import { createIdentity, identityFromSeedB64 } from "../src/identity";
import { CommunitySession, type CommunityState } from "../src/groupCommunity";
// covers: groups.community.join

/*
 * A joiner checks the group's whole membership history, one Ed25519 signature per commit in JavaScript (~2.6 ms each on
 * a desktop CPU), when the welcome comes. A history near its 2048 commits checked at once held the page's thread for 5 s:
 * an app that drew nothing and took no input. Checked a slice at a time, the thread runs what waits between slices.
 */
const hooks = { save: async (_state: CommunityState) => {}, broadcast: () => 0, direct: () => {}, addressed: () => {}, message: () => {}, changed: () => {} };
const clone = <T>(v: T): T => structuredClone(v);

describe("joining a community with a long membership history", () => {
  it("lets the thread go while the history is checked, and joins as the one-shot check does", async () => {
    const admin = new CommunitySession(CommunitySession.create("Town"), hooks);
    for (let i = 0; i < 150; i++) await admin.rotate();
    const seedB64 = createIdentity().seedB64;
    const frames = await admin.admit(identityFromSeedB64(seedB64).pubKeyZ32);
    const link = { g: admin.id, host: admin.entryKey };

    // The page's other tasks: one turn after another, each noting how long the thread was away since the last.
    let turns = 0, last = performance.now(), longest = 0, running = true;
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      const now = performance.now();
      longest = Math.max(longest, now - last);
      last = now;
      turns++;
      if (running) channel.port2.postMessage(null);
    };
    const started = performance.now();
    channel.port2.postMessage(null);
    const joined = await CommunitySession.joinPaced(link, clone(frames.slice(0, -1)), clone(frames[frames.length - 1]), seedB64, 1);
    const total = performance.now() - started;
    running = false;
    channel.port1.close();

    if ("error" in joined) throw new Error(joined.error);
    expect(joined.state.chain.length).toBe(admin.state.chain.length);
    expect(joined).toEqual(CommunitySession.join(link, clone(frames.slice(0, -1)), clone(frames[frames.length - 1]), seedB64, 1));
    // 152 signatures: a hundred milliseconds and more, in slices of a few each.
    expect(turns).toBeGreaterThan(3);
    expect(longest).toBeLessThan(total / 4);
  });

  it("refuses a history with one bad signature, as the one-shot check does", async () => {
    const admin = new CommunitySession(CommunitySession.create("Town"), hooks);
    for (let i = 0; i < 20; i++) await admin.rotate();
    const seedB64 = createIdentity().seedB64;
    const frames = clone(await admin.admit(identityFromSeedB64(seedB64).pubKeyZ32)) as { commits?: { sig: string }[] }[];
    const welcome = frames[frames.length - 1];
    const commit = welcome.commits![5];
    commit.sig = (commit.sig[0] === "A" ? "B" : "A") + commit.sig.slice(1);
    const link = { g: admin.id, host: admin.entryKey };
    const paced = await CommunitySession.joinPaced(link, frames.slice(0, -1), welcome, seedB64);
    expect(paced).toEqual(CommunitySession.join(link, frames.slice(0, -1), welcome, seedB64));
    expect(paced).toHaveProperty("error");
  });
});
