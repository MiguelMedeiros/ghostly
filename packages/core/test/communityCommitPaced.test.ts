import { describe, expect, it } from "vitest";
import { toBase64Url } from "../src/bytes";
import { createIdentity, sign } from "../src/identity";
import { CommunitySession, communityCommitHash, leaveStatement, leaveStatement3, type CommunityState } from "../src/groupCommunity";
// covers: groups.community.leave

/*
 * A commit that takes someone out (a leave, a remove, a rotation) opens a fresh epoch, whose secret is sealed to every
 * member left: one X25519 agreement each, ~0.9 ms in JavaScript on a desktop CPU, several times that on a phone. At 250
 * members that was 230 ms the page's thread never came back, and a hub committing the 40 leave requests it held (its tick
 * commits them all at once) drew nothing for 8.6 s. Sealed a slice at a time, the thread runs what waits between slices.
 */
describe("a community commit that opens a fresh epoch", () => {
  it("lets the thread go while the secret is sealed to each member, and every member still gets it", async () => {
    const sent: { to: string; h: string }[] = [];
    const hooks = { save: async (_state: CommunityState) => {}, broadcast: () => 0, direct: () => {}, addressed: (to: string, f: { t: string; h?: string }) => { if (f.t === "group-secret") sent.push({ to, h: f.h! }); }, message: () => {}, changed: () => {} };
    const admin = new CommunitySession(CommunitySession.create("Town"), hooks);
    const members = Array.from({ length: 100 }, () => createIdentity());
    for (const m of members) await admin.admit(m.pubKeyZ32);
    // Four signed leave requests held, as a hub holds them until its tick.
    for (const m of members.slice(0, 4)) {
      const add = admin.state.chain.find(c => c.k === "add" && c.s === m.pubKeyZ32)!;
      await admin.handle(m.pubKeyZ32, { t: "group-leave", v: 2, g: admin.id, s: m.pubKeyZ32, ls: toBase64Url(sign(leaveStatement(admin.id, m.pubKeyZ32), m.seed)),
        ls3: toBase64Url(sign(leaveStatement3(admin.id, m.pubKeyZ32, communityCommitHash(add)), m.seed)) });
    }
    expect(admin.state.pendingLeaves).toHaveLength(4);
    sent.length = 0;

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
    expect(await admin.commitPendingLeaves()).toBe(4);
    const total = performance.now() - started;
    running = false;
    channel.port1.close();

    // Each leave's secret went to each member still in after it: 99, 98, 97, 96 of them.
    const leaves = admin.state.chain.slice(-4);
    expect(leaves.map(c => c.k)).toEqual(["leave", "leave", "leave", "leave"]);
    expect(leaves.map(c => sent.filter(s => s.h === communityCommitHash(c)).length)).toEqual([99, 98, 97, 96]);
    expect(new Set(sent.map(s => s.to + s.h)).size).toBe(sent.length);
    // ~390 agreements: hundreds of milliseconds, in slices of a few each.
    expect(turns).toBeGreaterThan(8);
    expect(longest).toBeLessThan(total / 8);
  });
});
