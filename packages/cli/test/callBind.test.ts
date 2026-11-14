import { afterEach, describe, expect, it, vi } from "vitest";

// `loadCallStack` is read once per process: each case loads its own copy of the module.
async function callsWith(bind: string): Promise<unknown> {
  vi.resetModules();
  vi.stubEnv("GHOSTLY_CALL_BIND", bind);
  const { loadCallStack } = await import("../src/calls/media");
  return loadCallStack();
}

afterEach(() => { vi.unstubAllEnvs(); });

describe("GHOSTLY_CALL_BIND", () => {
  it("a name, not an address, turns calls off and says why: libdatachannel gathers no candidate on it", async () => {
    // Every call rang, stayed connecting and ended failed 30 s later, while status said calls: true.
    expect(await callsWith("localhost")).toMatch(/GHOSTLY_CALL_BIND takes an IP address of this machine/);
    // The contact's app shows the reason: a name of this network is not in it.
    expect(await callsWith("printer.lan")).not.toContain("printer.lan");
    expect(await callsWith("127.0.0.1:5000")).toMatch(/GHOSTLY_CALL_BIND takes an IP address/);
  });

  it("an address, IPv4 or IPv6, keeps calls on", async () => {
    for (const bind of ["127.0.0.1", "0.0.0.0", "::1"]) expect(typeof await callsWith(bind)).toBe("object");
  });

  it("an address that is not this machine's (now) refuses the call, and the daemon goes on", async () => {
    // 192.0.2.1 is TEST-NET-1, never a machine's. libdatachannel threw from the offer's description where nothing
    // catches it: the process aborted ("Failed to gather local ICE candidates"), every chat of the daemon with it.
    const stack = await callsWith("192.0.2.1");
    if (typeof stack === "string") throw new Error(stack);
    vi.stubEnv("GHOSTLY_STUN", "0");
    const { CallMedia, EarlyAnswer } = await import("../src/calls/media");
    const options = { rate: 48000 as const, onFrame: () => {}, onState: () => {}, iceServers: [] };
    await expect(CallMedia.offer(stack as never, options)).rejects.toMatchObject({ code: "unavailable", message: expect.stringMatching(/GHOSTLY_CALL_BIND is not an address of this machine now/) });
    // Answering said so too (it threw libdatachannel's own words): the call ends, the contact hears it could not connect.
    const offer = { t: "o" as const, ts: 1, u: "abcd", p: "0123456789abcdefghijkl", f: "AA:".repeat(31) + "AA", c: ["1 1 udp 2122317823 127.0.0.1 50000 typ host"], v: 0 as const };
    await expect(EarlyAnswer.open(stack as never, offer as never, options)).rejects.toMatchObject({ code: "unavailable" });
  });
});
