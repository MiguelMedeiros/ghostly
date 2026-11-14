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
});
