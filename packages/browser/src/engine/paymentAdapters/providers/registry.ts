import { cashuMint } from "./cashuMint";
import type { LightningProviderDescriptor } from "./lightning";
import type { OnchainProviderDescriptor } from "./onchain";
import { fakeLightning, fakeOnchain, testProvidersEnabled } from "./testing";
import { networkMode, type ProviderNetwork, type ProviderPlatform } from "./types";
import type { WalletMode } from "../../../shared/mints";

/**
 * Every wallet provider Ghostly knows. Adding one is adding its module next to this file and ONE line in
 * the list of its kind; see PROVIDERS.md. The order is the order of the source picker.
 */
export const LIGHTNING_PROVIDERS: readonly LightningProviderDescriptor[] = [
  cashuMint,
];

export const ONCHAIN_PROVIDERS: readonly OnchainProviderDescriptor[] = [
];

export interface ProviderRegistry {
  lightning: readonly LightningProviderDescriptor[];
  onchain: readonly OnchainProviderDescriptor[];
}

/** The registered providers, plus the fake ones when this browser asked for them (e2e). */
export function defaultRegistry(): ProviderRegistry {
  const fakes = testProvidersEnabled();
  return {
    lightning: [...LIGHTNING_PROVIDERS, ...(fakes ? [fakeLightning] : [])],
    onchain: [...ONCHAIN_PROVIDERS, ...(fakes ? [fakeOnchain] : [])],
  };
}

/** A provider can be offered here: it runs on this platform and on a network of this mode. */
export const offeredIn = (descriptor: { platforms: readonly ProviderPlatform[]; networks: readonly ProviderNetwork[] }, platform: ProviderPlatform, mode: WalletMode) =>
  descriptor.platforms.includes(platform) && descriptor.networks.some((network) => networkMode(network) === mode);
