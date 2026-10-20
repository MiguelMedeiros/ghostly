import { describe, expect, it } from "vitest";
import { addressOf } from "../../../infra/services/hyperdht-relay/relay.mjs";

// covers: transport.hyperdht-relay

const req = (headers: Record<string, string> = {}) => ({ headers, socket: { remoteAddress: "10.0.0.1" } });

describe("the HyperDHT relay's count of a client's address (infra/services/hyperdht-relay)", () => {
  it("behind proxies, counts the X-Forwarded-For entry that many from the end, not the ones the client writes", () => {
    expect(addressOf(req({ "x-forwarded-for": "10.9.1.1, 203.0.113.7" }), { proxies: 1 })).toBe("203.0.113.7");
    expect(addressOf(req({ "x-forwarded-for": "10.9.2.1, 203.0.113.7" }), { proxies: 1 })).toBe("203.0.113.7");
    expect(addressOf(req({ "x-forwarded-for": "9.9.9.9, 203.0.113.7, 172.16.0.2" }), { proxies: 2 })).toBe("203.0.113.7");
    expect(addressOf(req(), { proxies: 1 })).toBe("10.0.0.1");
    expect(addressOf(req({ "x-forwarded-for": "203.0.113.7" }), { proxies: 2 })).toBe("10.0.0.1");
  });

  it("takes CF-Connecting-IP only when told it is behind Cloudflare, and no header at all when told nothing", () => {
    const spoofed = req({ "cf-connecting-ip": "198.51.100.1", "x-forwarded-for": "198.51.100.2" });
    expect(addressOf(spoofed)).toBe("10.0.0.1");
    expect(addressOf(spoofed, { proxies: 1 })).toBe("198.51.100.2");
    expect(addressOf(spoofed, { cloudflare: true })).toBe("198.51.100.1");
    expect(addressOf(req(), { cloudflare: true })).toBe("10.0.0.1");
  });
});
