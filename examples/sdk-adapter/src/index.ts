import { SDK_API, type GhostlyAdapterPlugin } from "@ghostly/sdk";
import { exampleSchnorr } from "./identity";
import { paperLightning } from "./lightning";

export { PaperLightning, paperLightning } from "./lightning";
export { exampleSchnorr, schnorrKeyring, schnorrSign, schnorrSubject } from "./identity";

/**
 * The plugin: what the app registers. Bundled into a build with
 * `GHOSTLY_PLUGINS=examples/sdk-adapter/src/index.ts`, or registered at run time with
 * `registerAdapters(plugin)` from code running in the app's page. See docs/SDK.md.
 */
const plugin: GhostlyAdapterPlugin = {
  id: "example-adapters",
  version: "0.1.0",
  sdk: SDK_API,
  lightning: [paperLightning],
  identities: [exampleSchnorr],
};
export default plugin;
