import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LightningProviderDescriptor } from "../src/engine/paymentAdapters/providers/lightning";
import { defaultRegistry, LIGHTNING_PROVIDERS, offeredIn, ONCHAIN_PROVIDERS } from "../src/engine/paymentAdapters/providers/registry";
import { fakeLightning, FakeLightningProvider, fakeOnchain, TEST_PROVIDERS_FLAG } from "../src/engine/paymentAdapters/providers/testing";
import { onAdaptersChanged, pluginProblems, registerAdapters, registeredPlugins, resetAdapterRegistry, reserveAdapterIds, SDK_API, type GhostlyAdapterPlugin } from "../src/plugins/registry";
import type { IdentityProofProvider } from "../src/proofs/contract";
import { IDENTITY_PROVIDERS, identityProvider, identityProviders } from "../src/proofs/registry";
import { fakeKey, TEST_IDENTITIES_FLAG } from "../src/proofs/testing";

/**
 * The rules every adapter list follows, built-in or plugin (adapterPlugins.test.ts has registration):
 * what a mode and a platform offer, test fakes only behind their flag, a plugin that takes a built-in's
 * id when nothing reserved it, and malformed plugin shapes.
 */

const lightning = (id: string, more: Partial<LightningProviderDescriptor> = {}): LightningProviderDescriptor =>
  ({ id, label: `Plugin ${id}`, kind: "lightning", description: "A plugin's Lightning source.", networks: ["regtest"], platforms: ["web"], fields: [],
    async create() { return new FakeLightningProvider(); }, ...more });
const reserveBuiltIns = () => {
  reserveAdapterIds("lightning", LIGHTNING_PROVIDERS.map((d) => d.id));
  reserveAdapterIds("onchain", ONCHAIN_PROVIDERS.map((d) => d.id));
  reserveAdapterIds("identity", IDENTITY_PROVIDERS.map((p) => p.id));
};
const flags = (values: Record<string, string>) => vi.stubGlobal("localStorage", { getItem: (key: string) => values[key] ?? null });

beforeEach(() => { resetAdapterRegistry(); reserveBuiltIns(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("what a mode and a platform offer", () => {
  it("a regtest-only provider is never offered in Mainnet, a mainnet one never in Testnet, and a platform it does not run on never", () => {
    const regtest = lightning("reg"), main = lightning("main", { networks: ["bitcoin"] }), both = lightning("both", { networks: ["bitcoin", "signet"], platforms: ["desktop"] });
    expect(offeredIn(regtest, "web", "mainnet")).toBe(false);
    expect(offeredIn(regtest, "web", "testnet")).toBe(true);
    expect(offeredIn(main, "web", "testnet")).toBe(false);
    expect(offeredIn(main, "web", "mainnet")).toBe(true);
    expect(offeredIn(both, "web", "mainnet")).toBe(false);
    expect(offeredIn(both, "desktop", "mainnet")).toBe(true);
    expect(offeredIn(both, "desktop", "testnet")).toBe(true);
  });

  it("the test fakes are never offered in Mainnet, even with their flag on", () => {
    expect(offeredIn(fakeLightning, "web", "mainnet")).toBe(false);
    expect(offeredIn(fakeOnchain, "desktop", "mainnet")).toBe(false);
  });
});

describe("test fakes only behind their flag", () => {
  it("are absent without the flag, with another value, or when storage cannot be read", () => {
    const ids = () => [...defaultRegistry().lightning, ...defaultRegistry().onchain].map((d) => d.id);
    expect(ids()).not.toContain(fakeLightning.id);
    flags({ [TEST_PROVIDERS_FLAG]: "true" });
    expect(ids()).not.toContain(fakeLightning.id);
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("SecurityError: storage is blocked"); } });
    expect(ids()).not.toContain(fakeLightning.id);
    expect(identityProviders().map((p) => p.id)).not.toContain("fake-key");
    flags({ [TEST_PROVIDERS_FLAG]: "1" });
    expect(defaultRegistry().onchain.map((d) => d.id).at(-1)).toBe(fakeOnchain.id);
    expect(identityProviders().map((p) => p.id)).not.toContain("fake-key"); // a flag of its own
    flags({ [TEST_IDENTITIES_FLAG]: "1" });
    expect(identityProvider("fake-key")).toBeDefined();
    expect(ids()).not.toContain(fakeLightning.id);
  });
});

describe("a built-in's id always wins", () => {
  it("a plugin registered before the built-ins reserved their ids is dropped from the lists, and said so once", () => {
    resetAdapterRegistry(); // nothing reserved: registerAdapters cannot tell
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const builtIn = LIGHTNING_PROVIDERS[0];
    const onchainId = ONCHAIN_PROVIDERS[0].id;
    registerAdapters({ id: "squatter", sdk: SDK_API, lightning: [lightning(builtIn.id, { label: "Not the real one" })], onchain: [{ ...fakeOnchain, id: onchainId }], identities: [{ ...fakeKey, id: IDENTITY_PROVIDERS[0].id } as IdentityProofProvider] });
    for (let i = 0; i < 2; i++) {
      const registry = defaultRegistry();
      expect(registry.lightning.filter((d) => d.id === builtIn.id)).toEqual([builtIn]);
      expect(registry.onchain.filter((d) => d.id === onchainId)).toEqual([ONCHAIN_PROVIDERS[0]]);
      expect(identityProviders().filter((p) => p.id === IDENTITY_PROVIDERS[0].id)).toEqual([IDENTITY_PROVIDERS[0]]);
    }
    expect(identityProvider(IDENTITY_PROVIDERS[0].id)).toBe(IDENTITY_PROVIDERS[0]);
    const messages = error.mock.calls.map((c) => String(c[0]));
    expect(messages.filter((m) => m.includes(`lightning provider ${builtIn.id} from a plugin is ignored`))).toHaveLength(1);
    expect(messages.filter((m) => m.includes(`onchain provider ${onchainId} from a plugin is ignored`))).toHaveLength(1);
    expect(messages.filter((m) => m.includes(`identity provider ${IDENTITY_PROVIDERS[0].id} from a plugin is ignored`))).toHaveLength(1);
  });
});

describe("malformed plugins", () => {
  // Shapes that are not lists at all: pluginRules.bug.test.ts.
  it("refuses an overlong or non-text version, a missing id, and a descriptor of the other kind", () => {
    const cases: [unknown, RegExp][] = [
      [{ sdk: SDK_API, lightning: [lightning("x")] }, /plugin id must match/],
      [{ id: "v", sdk: SDK_API, version: 1, lightning: [lightning("x")] }, /version must be a short string/],
      [{ id: "v", sdk: SDK_API, version: "1".repeat(65), lightning: [lightning("x")] }, /version must be a short string/],
      [{ id: "o2", sdk: SDK_API, onchain: [{ ...fakeOnchain, id: "o2-btc", kind: "lightning" }] }, /says kind lightning/],
    ];
    for (const [plugin, message] of cases) {
      expect(() => registerAdapters(plugin as GhostlyAdapterPlugin)).toThrow(message);
    }
    expect(pluginProblems({ id: "fine", sdk: SDK_API, version: "1.0.0", onchain: [{ ...fakeOnchain, id: "fine-btc" }] })).toEqual([]);
    expect(registeredPlugins()).toEqual([]);
  });

  it("a plugin with only identities lists nothing among wallet sources; unregistering twice is harmless and a failing listener does not stop the others", () => {
    const heard = vi.fn();
    const stopBad = onAdaptersChanged(() => { throw new Error("listener bug"); });
    const stop = onAdaptersChanged(heard);
    const plugin: GhostlyAdapterPlugin = { id: "ids-only", sdk: SDK_API, identities: [{ ...fakeKey, id: "ids-only-key" } as IdentityProofProvider] };
    const unregister = registerAdapters(plugin);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(defaultRegistry().lightning).toEqual(LIGHTNING_PROVIDERS);
    expect(identityProvider("ids-only-key")).toBeDefined();
    unregister();
    unregister();
    expect(heard).toHaveBeenCalledTimes(2);
    // A plugin registered again under the same id is not removed by the first one's unregister.
    const again = registerAdapters({ ...plugin });
    unregister();
    expect(registeredPlugins().map((p) => p.id)).toEqual(["ids-only"]);
    again();
    stop(); stopBad();
  });
});

describe("plugins bundled into the build", () => {
  it("a broken one that throws something other than an Error is still reported and skipped", async () => {
    vi.resetModules();
    const odd = { get id(): string { throw "not an error"; }, sdk: SDK_API };
    vi.doMock("../src/plugins/bundled", () => ({ BUNDLED_PLUGINS: [odd, { id: "ok", sdk: SDK_API, lightning: [lightning("ok-ln")] }] }));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const fresh = await import("../src/plugins/registry");
      fresh.resetAdapterRegistry();
      expect(fresh.registeredPlugins().map((p) => p.id)).toEqual(["ok"]);
      expect(error).toHaveBeenCalledWith("[ghostly] a bundled adapter plugin was not loaded: not an error");
    } finally { vi.doUnmock("../src/plugins/bundled"); }
  });
});
