import { describe, expect, it } from "vitest";
import { localHost } from "../src/services";
// covers: headless.services

/** `service.open`'s loopback port answers a page that asks for it by this machine's name, not by any name resolving here. */
describe("an opened service's Host check", () => {
  it("takes 127.0.0.1, localhost and [::1] on its own port, and nothing else", () => {
    expect(localHost("127.0.0.1:4800", 4800)).toBe(true);
    expect(localHost("LOCALHOST:4800", 4800)).toBe(true);
    expect(localHost("[::1]:4800", 4800)).toBe(true);
    expect(localHost("127.0.0.1:4801", 4800)).toBe(false);
    expect(localHost("rebind.example:4800", 4800)).toBe(false);
    expect(localHost("127.0.0.1", 4800)).toBe(false);
    expect(localHost(undefined, 4800)).toBe(false);
  });
});
