import type { BreezSdkModule } from "./breezSdk";
import { isRecoveryPhrase, normalizePhrase } from "./recoveryPhrase";
import type { LightningProviderDescriptor } from "./lightning";
import type { ProviderNetwork, ProviderPlatform } from "./types";

/** Breez as the source picker lists it. The client (`./breez`) and the Breez SDK load when a wallet connects, not with the app. */

export const BREEZ_SOURCE = "breez";
/**
 * Where the Breez source is offered: Mainnet ("bitcoin", with the person's Breez API key, which the form requires
 * there) and Breez and Lightspark's hosted regtest (no API key).
 */
export const BREEZ_NETWORKS: readonly ProviderNetwork[] = ["bitcoin", "regtest"];
/** WebAssembly and HTTPS only: the page, the extension's offscreen document and Tauri's WebView all run it. */
export const BREEZ_PLATFORMS: readonly ProviderPlatform[] = ["web", "extension", "desktop"];

/** The descriptor, with the SDK it loads (tests hand it a fake). */
export const breezDescriptor = (sdk?: () => Promise<BreezSdkModule>): LightningProviderDescriptor => ({
  id: BREEZ_SOURCE,
  label: "Breez (Spark)",
  kind: "lightning",
  description: "A self-custodial Lightning wallet on Spark, through the Breez SDK. Its recovery phrase is sealed on this device; you hold the sats.",
  networks: BREEZ_NETWORKS,
  platforms: BREEZ_PLATFORMS,
  fields: [
    { name: "mnemonic", label: "Recovery phrase", kind: "secret", placeholder: "twelve words…", help: "Made by Ghostly for a new wallet, or yours to restore one." },
    { name: "apiKey", label: "Breez API key", kind: "secret", optional: true, help: "Required on Mainnet (free, from Breez). Not needed in Testnet (regtest)." },
  ],
  experimental: true,
  validate({ secrets }, mode) {
    if (!isRecoveryPhrase(secrets.mnemonic ?? "")) throw new Error("That is not a valid recovery phrase");
    if (mode === "mainnet" && !secrets.apiKey?.trim()) throw new Error("Breez needs an API key on Mainnet");
  },
  async create({ secrets }, host) {
    const network: ProviderNetwork = host.mode === "mainnet" ? "bitcoin" : "regtest";
    const { BreezLightning } = await import("./breez");
    return BreezLightning.connect({ network, mnemonic: normalizePhrase(secrets.mnemonic), apiKey: secrets.apiKey?.trim() || undefined }, sdk);
  },
});

export const breez = breezDescriptor();
