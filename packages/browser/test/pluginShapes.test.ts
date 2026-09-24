import { describe, expect, it } from "vitest";
import { pluginProblems, registerAdapters, SDK_API, type GhostlyAdapterPlugin } from "../src/plugins/registry";
// covers: sdk.registry, sdk.package

/**
 * `pluginProblems` is the SDK's validator: docs/SDK.md says it lists why a plugin is refused. An adapter
 * field that is not a list, or a list with a hole in it, is one of those reasons, not a TypeError, and
 * `registerAdapters` refuses it with its own "Cannot register plugin" message.
 */
describe("pluginProblems on malformed shapes", () => {
  const shapes: [string, unknown, RegExp][] = [
    ["lightning is an object", { id: "l", sdk: SDK_API, lightning: {} }, /lightning must be a list of descriptors/],
    ["onchain is a string", { id: "o", sdk: SDK_API, onchain: "bdk" }, /onchain must be a list of descriptors/],
    ["identities is an object", { id: "i", sdk: SDK_API, identities: {} }, /identities must be a list of providers/],
    ["a lightning entry is null", { id: "n", sdk: SDK_API, lightning: [null] }, /lightning null/],
    ["an identity entry is null", { id: "m", sdk: SDK_API, identities: [null] }, /identity null/],
  ];
  for (const [name, plugin, message] of shapes) {
    it(`lists the problem instead of throwing when ${name}`, () => {
      expect(pluginProblems(plugin as GhostlyAdapterPlugin).join("; ")).toMatch(message);
      expect(() => registerAdapters(plugin as GhostlyAdapterPlugin)).toThrow(/^Cannot register plugin/);
    });
  }
});
