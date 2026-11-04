import { expect, it } from "vitest";
import { createIdentity, identityFromSeedB64 } from "../src/identity";
import { CommunitySession, type CommunityFrame, type CommunitySessionHooks, type CommunityState } from "../src/groupCommunity";
// covers: groups.catch-up

/*
 * agents#1767: a member back after many joins and leaves saved its whole community state at once for every commit (and
 * every secret) it was handed: 1,000 commits were 1,051 whole-record writes, 241 MB of journal on the CLI store. They
 * are saved now as its messages are, within a second; a change of its own place in the group still at once.
 */
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

it("a member handed 60 commits and their secrets saves its state a few times, not once each, and keeps them all", async () => {
  const toBob: CommunityFrame[] = [];
  let bobKey = "";
  const aliceHooks: CommunitySessionHooks = {
    save: async () => {}, message: () => {}, changed: () => {},
    broadcast: frame => { toBob.push(clone(frame)); return 1; },
    direct: (to, frame) => { if (to === bobKey) toBob.push(clone(frame)); return true; },
    addressed: (to, frame) => { if (to === bobKey) toBob.push(clone(frame)); },
  };
  const alice = new CommunitySession(CommunitySession.create("Ghosts"), aliceHooks);
  const bobSeed = createIdentity().seedB64;
  bobKey = identityFromSeedB64(bobSeed).pubKeyZ32;
  const frames = await alice.admit(bobKey);
  const joined = CommunitySession.join({ g: alice.id, host: alice.entryKey }, clone(frames.slice(0, -1)), clone(frames[frames.length - 1]), bobSeed);
  if ("error" in joined) throw new Error(joined.error);
  toBob.length = 0;

  // Bob's app is closed while Alice lets 30 people in and takes each out again (a fresh secret every time).
  for (let i = 0; i < 30; i++) {
    const key = createIdentity().pubKeyZ32;
    await alice.admit(key);
    await alice.remove(key);
  }
  const top = alice.state.chain.length;

  const saved: CommunityState[] = [];
  const bob = new CommunitySession(clone(joined.state), {
    save: async state => { saved.push(state); }, message: () => {}, changed: () => {},
    broadcast: () => 0, direct: () => true, addressed: () => {},
  });
  for (const frame of toBob) await bob.handle(alice.myKey, frame);
  console.log(`CATCHUP SAVES: ${toBob.length} frames, chain ${bob.state.chain.length}/${top}, ${saved.length} saves`);
  expect(bob.state.chain.length).toBe(top);
  expect(saved.length).toBeLessThanOrEqual(2);

  // Written when the engine flushes (before a restart) or a second later: everything taken is in it.
  await bob.flush();
  expect(saved.at(-1)!.chain.length).toBe(top);
  expect(Object.keys(saved.at(-1)!.secrets)).toEqual(Object.keys(bob.state.secrets));
  expect(bob.isMember).toBe(true);
});

it("a member taken out saves that at once", async () => {
  let bobKey = "";
  const toBob: CommunityFrame[] = [];
  const alice = new CommunitySession(CommunitySession.create("Ghosts"), {
    save: async () => {}, message: () => {}, changed: () => {},
    broadcast: frame => { toBob.push(clone(frame)); return 1; },
    direct: (to, frame) => { if (to === bobKey) toBob.push(clone(frame)); return true; },
    addressed: (to, frame) => { if (to === bobKey) toBob.push(clone(frame)); },
  });
  const bobSeed = createIdentity().seedB64;
  bobKey = identityFromSeedB64(bobSeed).pubKeyZ32;
  const frames = await alice.admit(bobKey);
  const joined = CommunitySession.join({ g: alice.id, host: alice.entryKey }, clone(frames.slice(0, -1)), clone(frames[frames.length - 1]), bobSeed);
  if ("error" in joined) throw new Error(joined.error);
  toBob.length = 0;
  await alice.remove(bobKey);
  const saved: CommunityState[] = [];
  const bob = new CommunitySession(clone(joined.state), {
    save: async state => { saved.push(state); }, message: () => {}, changed: () => {},
    broadcast: () => 0, direct: () => true, addressed: () => {},
  });
  for (const frame of toBob) await bob.handle(alice.myKey, frame);
  expect(bob.isMember).toBe(false);
  expect(saved.some(state => state.status === "removed")).toBe(true);
});
