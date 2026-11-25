// covers: groups.protocol.community-topology
import { afterEach, describe, expect, it } from "vitest";
import { createIdentity, identityFromSeedB64, setAsyncVerifyFastPath } from "../src/identity";
import { toZ32 } from "../src";
import { CommunitySession, type CommunityFrame, type CommunityState } from "../src/groupCommunity";

/*
 * A page checks the signature of every frame a community brings by its WebCrypto, async (`verifyAsync`): a catch-up of
 * 256 frames took ~180 ms of the page's thread by noble's check in Chromium, ~25 ms by WebCrypto's.
 */

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

class Net {
  readonly sessions = new Map<string, CommunitySession>();
  readonly texts = new Map<string, string[]>();
  readonly msgs: { to: string; from: string; frame: CommunityFrame }[] = [];
  private pending: Promise<unknown>[] = [];
  private hooks(name: string) {
    const deliver = (to: string | undefined, frame: CommunityFrame) => {
      const me = this.sessions.get(name)!, them = to && this.sessions.get(to);
      if (!them || them === me) return;
      if (frame.t === "group-msg") this.msgs.push({ to: to!, from: me.myKey, frame: clone(frame) });
      this.pending.push(them.handle(me.myKey, clone(frame)));
    };
    const byKey = (key: string) => [...this.sessions].find(([, s]) => s.myKey === key)?.[0];
    return {
      save: async (_: CommunityState) => {},
      broadcast: (frame: CommunityFrame) => { for (const other of this.sessions.keys()) deliver(other, frame); },
      direct: (to: string, frame: CommunityFrame) => deliver(byKey(to), frame),
      addressed: (to: string, frame: CommunityFrame) => deliver(byKey(to), frame),
      message: (m: { text: string }) => { this.texts.get(name)!.push(m.text); },
      changed: () => {},
    };
  }
  add(name: string, state: CommunityState): CommunitySession {
    this.texts.set(name, []);
    const session = new CommunitySession(state, this.hooks(name));
    this.sessions.set(name, session);
    return session;
  }
  async admit(by: CommunitySession, name: string): Promise<CommunitySession> {
    const seedB64 = createIdentity().seedB64;
    const frames = await by.admit(identityFromSeedB64(seedB64).pubKeyZ32);
    await this.settle();
    const joined = CommunitySession.join({ g: by.id, host: by.entryKey }, clone(frames.slice(0, -1)), clone(frames[frames.length - 1]), seedB64);
    if ("error" in joined) throw new Error(joined.error);
    return this.add(name, joined.state);
  }
  async settle(): Promise<void> {
    for (let i = 0; i < 200; i++) { const batch = this.pending.splice(0); if (!batch.length) break; await Promise.all(batch); }
  }
}

/** Node's WebCrypto, as a page's, counting whom it was asked about. */
const asked: string[] = [];
const subtle = async (sig: Uint8Array, msg: Uint8Array, key: Uint8Array) => {
  asked.push(toZ32(key));
  const imported = await crypto.subtle.importKey("raw", new Uint8Array(key), { name: "Ed25519" }, false, ["verify"]);
  return crypto.subtle.verify({ name: "Ed25519" }, imported, new Uint8Array(sig), new Uint8Array(msg));
};

afterEach(() => { setAsyncVerifyFastPath(null); asked.length = 0; });

describe("a community member given a message frame", () => {
  it("checks its signature by the host's async check, and still refuses one that does not hold", async () => {
    const net = new Net();
    const alice = net.add("alice", CommunitySession.create("Ghosts"));
    const bob = await net.admit(alice, "bob");
    await net.settle();
    setAsyncVerifyFastPath(subtle);

    await alice.sendText("hello");
    await net.settle();
    expect(net.texts.get("bob")).toEqual(["hello"]);    expect(asked).toEqual([alice.myKey]);

    // Another of alice's frames whose text was changed on the way: refused, by the async check and the strict one.
    await alice.sendText("second");
    const toBob = net.msgs.filter(m => m.to === "bob"), sent = toBob[toBob.length - 1];
    const changed = clone(sent.frame) as CommunityFrame & { c: string; n: number };
    changed.n += 1;
    asked.length = 0;
    net.texts.set("bob", []);
    expect(await bob.handle(sent.from, changed)).toBe(false);
    expect(asked).toEqual([alice.myKey]);
    await net.settle();
    expect(net.texts.get("bob")).toEqual(["second"]);
  });
});
