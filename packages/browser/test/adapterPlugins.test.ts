import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LightningProviderDescriptor } from "../src/engine/paymentAdapters/providers/lightning";
import type { OnchainProviderDescriptor } from "../src/engine/paymentAdapters/providers/onchain";
import { defaultRegistry, LIGHTNING_PROVIDERS, ONCHAIN_PROVIDERS } from "../src/engine/paymentAdapters/providers/registry";
import { ProviderSources } from "../src/engine/paymentAdapters/providers/sources";
import { fakeLightning, FakeLightningProvider, fakeOnchain, TEST_PROVIDERS_FLAG } from "../src/engine/paymentAdapters/providers/testing";
import { isNothingSpentError, NothingSpentError, providerDescriptorProblems, type ProviderDescriptor } from "../src/engine/paymentAdapters/providers/types";
import { onAdaptersChanged, pluginProblems, registerAdapters, registeredPlugins, resetAdapterRegistry, reserveAdapterIds, SDK_API, type GhostlyAdapterPlugin } from "../src/plugins/registry";
import type { IdentityProofProvider } from "../src/proofs/contract";
import { IDENTITY_PROVIDERS, identityProviders } from "../src/proofs/registry";
import { fakeKey } from "../src/proofs/testing";
// covers: sdk.registry, sdk.plugin.bundled, wallet.lightning.provider-contract, wallet.onchain.provider-contract

/**
 * Adapters from outside the app: what `registerAdapters` accepts, what it refuses, and where the
 * registries then list them. See plugins/registry.ts and docs/SDK.md.
 */
const lightning = (id: string, more: Partial<LightningProviderDescriptor> = {}): LightningProviderDescriptor =>
  ({ id, label: `Plugin ${id}`, kind: "lightning", description: "A plugin's Lightning source.", networks: ["regtest"], platforms: ["web"], fields: [],
    async create() { return new FakeLightningProvider(); }, ...more });
const onchain = (id: string): OnchainProviderDescriptor => ({ ...fakeOnchain, id, label: `Plugin ${id}` });
const identity = (id: string): IdentityProofProvider => ({ ...fakeKey, id, label: `Plugin ${id}` } as IdentityProofProvider);
const plugin = (id: string, more: Partial<GhostlyAdapterPlugin> = {}): GhostlyAdapterPlugin => ({ id, sdk: SDK_API, lightning: [lightning(`${id}-ln`)], ...more });

beforeEach(() => {
  resetAdapterRegistry();
  reserveAdapterIds("lightning", LIGHTNING_PROVIDERS.map((d) => d.id));
  reserveAdapterIds("onchain", ONCHAIN_PROVIDERS.map((d) => d.id));
  reserveAdapterIds("identity", IDENTITY_PROVIDERS.map((p) => p.id));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("registerAdapters", () => {
  it("lists a plugin's adapters after the built-ins and before the test fakes", () => {
    vi.stubGlobal("localStorage", { getItem: (key: string) => (key === TEST_PROVIDERS_FLAG ? "1" : null) });
    const unregister = registerAdapters(plugin("acme", { lightning: [lightning("acme-ln")], onchain: [onchain("acme-btc")], identities: [identity("acme-id")] }));
    const registry = defaultRegistry();
    expect(registry.lightning.map((d) => d.id)).toEqual([...LIGHTNING_PROVIDERS.map((d) => d.id), "acme-ln", fakeLightning.id]);
    expect(registry.onchain.map((d) => d.id)).toEqual([...ONCHAIN_PROVIDERS.map((d) => d.id), "acme-btc", fakeOnchain.id]);
    expect(identityProviders().map((p) => p.id)).toContain("acme-id");
    expect(identityProviders().findIndex((p) => p.id === "acme-id")).toBe(IDENTITY_PROVIDERS.length);
    unregister();
    expect(defaultRegistry().lightning.map((d) => d.id)).not.toContain("acme-ln");
    expect(identityProviders().map((p) => p.id)).not.toContain("acme-id");
  });

  it("is read each time: a plugin registered after the registry was made shows up on the next read", () => {
    const registry = defaultRegistry();
    expect(registry.lightning.map((d) => d.id)).not.toContain("late-ln");
    registerAdapters(plugin("late"));
    expect(registry.lightning.map((d) => d.id)).toContain("late-ln");
  });

  it("tells listeners, and the pickers recompute what is offered without reconnecting", async () => {
    const changed = vi.fn();
    const stop = onAdaptersChanged(changed);
    const sources = new ProviderSources<FakeLightningProvider>({ kind: "lightning", descriptors: () => defaultRegistry().lightning, host: () => ({ platform: "web" }), changed: vi.fn() });
    await sources.start("testnet");
    const before = sources.view.offered.map((d) => d.id);
    expect(before).not.toContain("web-ln");
    registerAdapters(plugin("web", { lightning: [lightning("web-ln", { platforms: ["web"] }), lightning("desk-ln", { platforms: ["desktop"] }), lightning("main-ln", { networks: ["bitcoin"] })] }));
    expect(changed).toHaveBeenCalledTimes(1);
    sources.refreshOffered();
    // Only what this platform and this mode can run: the platform and network rules are the same for plugins.
    expect(sources.view.offered.map((d) => d.id)).toEqual([...before, "web-ln"]);
    expect(sources.view.status).toBe("none"); // nothing was connected, nothing is
    stop();
    registerAdapters(plugin("other"));
    expect(changed).toHaveBeenCalledTimes(1);
    await sources.stop();
  });

  it("refuses a malformed plugin, and registers nothing of it", () => {
    const attempts: [GhostlyAdapterPlugin, RegExp][] = [
      [{ id: "Bad Id", sdk: SDK_API, lightning: [lightning("x")] }, /plugin id/],
      [{ id: "old", sdk: 2, lightning: [lightning("x")] }, /SDK API 2/],
      [{ id: "empty", sdk: SDK_API }, /no adapter/],
      [{ id: "kind", sdk: SDK_API, lightning: [{ ...lightning("x"), kind: "onchain" } as unknown as LightningProviderDescriptor] }, /says kind onchain/],
      [{ id: "net", sdk: SDK_API, lightning: [lightning("x", { networks: ["liquid" as never] })] }, /unknown network liquid/],
      [{ id: "plat", sdk: SDK_API, lightning: [lightning("x", { platforms: ["ios" as never] })] }, /unknown platform ios/],
      [{ id: "fields", sdk: SDK_API, lightning: [lightning("x", { fields: [{ name: "a", label: "A", kind: "select" }] })] }, /select without options/],
      [{ id: "dup", sdk: SDK_API, lightning: [lightning("x"), lightning("x")] }, /not unique within/],
      [{ id: "noverify", sdk: SDK_API, identities: [{ ...identity("x"), signers: [] }] }, /no signers/],
      [{ id: "taken", sdk: SDK_API, lightning: [lightning(LIGHTNING_PROVIDERS[0].id)] }, /is a built-in/],
      [{ id: "taken-id", sdk: SDK_API, identities: [identity(IDENTITY_PROVIDERS[0].id)] }, /is a built-in/],
    ];
    for (const [bad, message] of attempts) expect(() => registerAdapters(bad), bad.id).toThrow(message);
    expect(registeredPlugins()).toEqual([]);
  });

  it("refuses a second plugin with the same id, or the same adapter id, and keeps the first", () => {
    const first = plugin("first", { lightning: [lightning("shared-ln")] });
    registerAdapters(first);
    expect(() => registerAdapters(plugin("first"))).toThrow(/already registered/);
    expect(() => registerAdapters(plugin("second", { lightning: [lightning("shared-ln")] }))).toThrow(/already registered by plugin first/);
    expect(registeredPlugins()).toEqual([first]);
  });

  it("checks a descriptor the way the registry does", () => {
    expect(providerDescriptorProblems(fakeLightning as ProviderDescriptor<unknown>)).toEqual([]);
    expect(providerDescriptorProblems({ ...fakeLightning, id: "X", label: " ", description: "", fields: [{ name: "1", label: "", kind: "nope" as never }] } as ProviderDescriptor<unknown>))
      .toEqual(["id must match ^[a-z][a-z0-9-]{0,31}$", "label is empty", "description is empty: say what it is and who holds the money", "field 1 has an invalid name", "field 1 has no label", "field 1 has an unknown kind"]);
    expect(pluginProblems(null as unknown as GhostlyAdapterPlugin)).toEqual(["not a plugin object"]);
  });

  it("shares one registry between two copies of the module, through globalThis", async () => {
    registerAdapters(plugin("shared"));
    vi.resetModules();
    const copy = await import("../src/plugins/registry");
    expect(copy.registeredPlugins().map((p) => p.id)).toEqual(["shared"]);
    copy.registerAdapters({ id: "from-copy", sdk: SDK_API, lightning: [lightning("copy-ln")] });
    expect(registeredPlugins().map((p) => p.id)).toEqual(["shared", "from-copy"]);
  });

  it("recognizes NothingSpentError by name, as a plugin's own copy of the class throws it", () => {
    class OtherCopy extends Error { constructor(m: string) { super(m); this.name = "NothingSpentError"; } }
    expect(isNothingSpentError(new NothingSpentError("x"))).toBe(true);
    expect(isNothingSpentError(new OtherCopy("x"))).toBe(true);
    expect(isNothingSpentError(new Error("NothingSpentError"))).toBe(false);
    expect(isNothingSpentError("NothingSpentError")).toBe(false);
  });
});

describe("plugins bundled into the build", () => {
  it("register themselves when first asked for, and a broken one is skipped and reported", async () => {
    vi.resetModules();
    vi.doMock("../src/plugins/bundled", () => ({ BUNDLED_PLUGINS: [plugin("bundled"), { id: "broken", sdk: 99 }] }));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const fresh = await import("../src/plugins/registry");
    fresh.resetAdapterRegistry();
    expect(fresh.registeredPlugins().map((p) => p.id)).toEqual(["bundled"]);
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/bundled adapter plugin was not loaded: Cannot register plugin broken/));
    vi.doUnmock("../src/plugins/bundled");
  });
});
