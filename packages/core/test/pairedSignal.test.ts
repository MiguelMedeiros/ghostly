import { describe, expect, it } from "vitest";
import { createIdentity } from "../src/identity";
import { fitSignedPairedSignal, signPairedSignal, verifyPairedSignal } from "../src/pairedSignal";

import { LinkSession } from "../src/link";
import { createLink } from "../src/invite";

const owner = createIdentity(), attacker = createIdentity();
const from = createIdentity().pubKeyZ32, to = createIdentity().pubKeyZ32;
const signal = JSON.stringify({ t: "o", ts: 100, u: "ufrag", p: "password", f: "a".repeat(64), s: "actpass", c: [] });
describe("participation-authenticated discovery signals", () => {
  it("fits a signed IPv6-rich signal into a real encrypted Pkarr packet before signing the final candidates", () => {
    const params = createLink().mine;
    const session = new LinkSession({ params, nick: "A reasonably long nickname",
      getServices: () => [{ id: "chat", type: "chat" }],
      transport: { publish: async () => {}, resolve: async () => null, describe: () => ({ protocol: "test", relays: [] }) } });
    const large = JSON.stringify({ ...JSON.parse(signal), ts: Date.now(), o: Date.now() - 1,
      u: "a".repeat(24), p: "b".repeat(48), c: [
        "h,2001:db8:ffff:ffff:ffff:ffff:ffff:ffff,65535", "h,2001:db8:eeee:eeee:eeee:eeee:eeee:eeee,65535",
        "s,203.0.113.1,54321", "s,203.0.113.2,54321", "r,203.0.113.3,54321"] });
    expect(session.fitsRtcSignal(signPairedSignal(large, owner.seedB64, from, to))).toBe(false);
    const fitted = fitSignedPairedSignal(large, owner.seedB64, from, to, candidate => session.fitsRtcSignal(candidate));
    expect(session.fitsRtcSignal(fitted)).toBe(true);
    expect(JSON.parse(fitted).c.length).toBeGreaterThan(0);
    expect(verifyPairedSignal(fitted, from, to, owner.pubKeyZ32, true)).not.toBeNull();
  });
  it("allows unsigned first-increment discovery only before migration is committed", () => {
    expect(verifyPairedSignal(signal, from, to, owner.pubKeyZ32)).toBe(signal);
    expect(verifyPairedSignal(signal, from, to, owner.pubKeyZ32, true)).toBeNull();
  });
  it("rejects a bootstrap holder without the pinned participation seed", () => {
    const forged = signPairedSignal(signal, attacker.seedB64, from, to);
    expect(verifyPairedSignal(forged, from, to, owner.pubKeyZ32, true)).toBeNull();
  });
  it("binds the direction, timestamp, ICE and DTLS contents before DataLink sees them", () => {
    const signed = signPairedSignal(signal, owner.seedB64, from, to);
    expect(verifyPairedSignal(signed, from, to, owner.pubKeyZ32, true)).toBe(signal);
    expect(verifyPairedSignal(signed, to, from, owner.pubKeyZ32, true)).toBeNull();
    for (const patch of [{ ts: 200 }, { f: "b".repeat(64) }, { p: "other" }]) {
      expect(verifyPairedSignal(JSON.stringify({ ...JSON.parse(signed), ...patch }), from, to, owner.pubKeyZ32, true)).toBeNull();
    }
  });
});
