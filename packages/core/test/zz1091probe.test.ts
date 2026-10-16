import { describe, expect, it, vi } from "vitest";
import { createIdentity } from "../src/identity";
import { createRelayPayload } from "../src/pkarr";
import { RelayTransport } from "../src/relay";

// Throwaway probe: 10 contacts leave at once; the goodbye burst (mailbox reads and envelopes); the chats' fast reads of
// them, `departed` for 30 s; when is each contact first read after it is back at +20 s.
describe("probe", () => {
  for (const burst of [0, 8, 12, 16]) it(`burst ${burst}`, async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const contacts = Array.from({ length: 10 }, () => createIdentity());
      const others = Array.from({ length: 40 }, () => createIdentity());
      const log: { key: string; method: string; host: string; at: number }[] = [];
      const relay = new RelayTransport({ freshReadMs: 0, relays: ["https://a.test", "https://b.test"], fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input)), key = url.pathname.slice(1);
        log.push({ key, method: init?.method ?? "GET", host: url.host, at: Date.now() });
        if (init?.method === "PUT") return new Response(null, { status: 204 });
        const peer = [...contacts, ...others].find((p) => p.pubKeyZ32 === key)!;
        return new Response(createRelayPayload(peer, [{ label: "_ts", value: "1" }], 3n) as BodyInit);
      }) as typeof fetch });
      const start = Date.now();
      for (let i = 0; i < burst; i++) await relay.resolve(others[i].pubKeyZ32).catch(() => {});
      for (let i = 0; i < burst / 2; i++) await relay.publish(others[20 + i], [{ label: "_ts", value: "1" }]).catch(() => {});
      for (let t = 0; t < 60_000; t += 2_000) {
        for (const [i, c] of contacts.entries()) {
          vi.setSystemTime(start + t + i * 5);
          await relay.resolve(c.pubKeyZ32, { urgent: true, watch: true, ...(t < 30_000 && { departed: true }) }).catch(() => {});
        }
      }
      const back = contacts.map((c) => { const at = log.find((r) => r.key === c.pubKeyZ32 && r.method === "GET" && r.at >= start + 20_000)?.at; return at === undefined ? null : at - start - 20_000; });
      const perHost = ["a.test", "b.test"].map((h) => log.filter((r) => r.host === h && r.at < start + 20_000).length);
      console.log(`burst ${burst}: before +20 s ${perHost}; first read after back ${JSON.stringify(back)}`);
      expect(back).toBeDefined();
    } finally { vi.useRealTimers(); }
  });
});
