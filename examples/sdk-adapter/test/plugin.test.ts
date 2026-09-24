import { afterEach, describe, expect, it } from "vitest";
import { pluginProblems, registerAdapters, registeredIdentityProviders, registeredLightningProviders, registeredPlugins, resetAdapterRegistry, SDK_API } from "@ghostly/sdk";
import plugin from "../src/index";

afterEach(() => resetAdapterRegistry());

describe("the example plugin", () => {
  it("is a plugin the app accepts", () => {
    expect(pluginProblems(plugin)).toEqual([]);
    expect(plugin.sdk).toBe(SDK_API);
  });
  it("registers its adapters, once, and can leave", () => {
    const unregister = registerAdapters(plugin);
    expect(registeredPlugins().map((p) => p.id)).toEqual(["example-adapters"]);
    expect(registeredLightningProviders().map((d) => d.id)).toEqual(["paper-lightning"]);
    expect(registeredIdentityProviders().map((p) => p.id)).toEqual(["example-schnorr"]);
    expect(() => registerAdapters(plugin)).toThrow(/already registered/);
    unregister();
    expect(registeredPlugins()).toEqual([]);
  });
});
