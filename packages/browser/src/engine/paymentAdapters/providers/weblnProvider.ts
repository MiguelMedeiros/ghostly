import type { LightningProviderDescriptor } from "./lightning";

/** A browser wallet (WebLN) as the source picker lists it. The client (`./webln`) loads when one connects, not with the app. */

export const WEBLN_SOURCE = "webln";

export const webln: LightningProviderDescriptor = {
  id: WEBLN_SOURCE,
  label: "Browser wallet (WebLN)",
  kind: "lightning",
  description: "A Lightning wallet in this browser (Alby and others). That wallet holds the sats and asks you before it pays.",
  networks: ["bitcoin", "testnet", "signet", "mutinynet", "regtest"],
  // Only the web app's page sees `window.webln`: not the extension's offscreen engine, not Tauri.
  platforms: ["web"],
  fields: [],
  experimental: true,
  async create(_settings, host) {
    const { WeblnLightning, findWebln } = await import("./webln");
    return WeblnLightning.connect(await findWebln(), host.mode, host.signal);
  },
};
