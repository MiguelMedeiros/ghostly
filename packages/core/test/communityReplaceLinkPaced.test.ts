import { describe, expect, it } from "vitest";
import { createIdentity } from "../src/identity";
import { CommunitySession, type CommunityState } from "../src/groupCommunity";
// covers: groups.community.join

/*
 * A new link's entry seed is sealed to every member, so any of them can answer it: one X25519 agreement each, ~0.9 ms in
 * JavaScript on a desktop CPU, several times that on a phone. At 250 members that was 230 ms the admin's page never got
 * its thread back. Sealed a slice at a time, the thread runs what waits between slices.
 */
describe("replacing a community's link", () => {
  it("lets the thread go while the new entry seed is sealed to each member, and every member still gets it", async () => {
    const sent: { to: string; x: string }[] = [];
    const hooks = { save: async (_state: CommunityState) => {}, broadcast: () => 0, direct: () => {}, addressed: (to: string, f: { t: string; x?: string }) => { if (f.t === "group-entry") sent.push({ to, x: f.x! }); }, message: () => {}, changed: () => {} };
    const admin = new CommunitySession(CommunitySession.create("Town"), hooks);
    const members = Array.from({ length: 100 }, () => createIdentity());
    for (const m of members) await admin.admit(m.pubKeyZ32);
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
    const key = await admin.replaceLink();
    const total = performance.now() - started;
    running = false;
    channel.port1.close();

    // The new seed went to each of the 100 members once.
    expect(sent.map(s => s.to).sort()).toEqual(members.map(m => m.pubKeyZ32).sort());
    expect(sent.every(s => s.x === key)).toBe(true);
    // ~100 agreements: about a hundred milliseconds, in slices of a few each. The longest wait left is the `link` commit
    // before them (its signature), not the sealing.
    expect(turns).toBeGreaterThan(8);
    expect(longest).toBeLessThan(total / 4);
  });
});
