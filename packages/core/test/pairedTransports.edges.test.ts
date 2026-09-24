import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { rankTransports, transportOrder, TRANSPORTS, type PairedTransport } from "../src/pairedTransports";

// covers: transport.switch, transport.preference, transport.iroh

const names = fc.constantFrom<string>(...TRANSPORTS, "tcp/1", "webrtc/2", "", "__proto__");
const list = fc.uniqueArray(names, { maxLength: 6 });
const available = fc.uniqueArray(fc.constantFrom(...TRANSPORTS), { maxLength: 3 });

describe("transport ranking properties", () => {
  it("ranks the same set in the same order whichever side computes it", () => {
    fc.assert(fc.property(list, list, (local, remote) => {
      expect(rankTransports(local, remote)).toEqual(rankTransports(remote, local));
    }), { numRuns: 200 });
  });

  it("only ever returns known transports both sides listed, each once", () => {
    fc.assert(fc.property(list, list, (local, remote) => {
      const ranked = rankTransports(local, remote);
      expect(new Set(ranked).size).toBe(ranked.length);
      for (const t of ranked) {
        expect(TRANSPORTS).toContain(t);
        expect(local).toContain(t);
        expect(remote).toContain(t);
      }
    }), { numRuns: 200 });
  });

  it("orders only available adapters, the preferred one first, others only with fallback", () => {
    fc.assert(fc.property(available, fc.constantFrom(...TRANSPORTS), fc.boolean(), (have, preferred: PairedTransport, fallback) => {
      const order = transportOrder(have, preferred, fallback);
      for (const t of order) expect(have).toContain(t);
      if (have.includes(preferred)) expect(order[0]).toBe(preferred);
      else expect(order).not.toContain(preferred);
      if (!fallback) expect(order.length).toBeLessThanOrEqual(1);
      else expect(order.length).toBe(have.length);
    }), { numRuns: 200 });
  });
});
