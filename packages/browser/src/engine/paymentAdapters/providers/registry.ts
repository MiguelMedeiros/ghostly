import { bdk } from "./bdk";
import { bitcoindRpc } from "./bitcoind";
import { breez } from "./breez";
import { cashuMint } from "./cashuMint";
import { fedimint } from "./fedimint";
import { coreLightning } from "./coreLightning";
import { nwc } from "./nwc";
import { lnd } from "./lnd";
import type { LightningProviderDescriptor } from "./lightning";
import type { OnchainProviderDescriptor } from "./onchain";
import { webln } from "./webln";
import { fakeLightning, fakeOnchain, testProvidersEnabled } from "./testing";
import { offeredIn } from "./types";
import { registeredLightningProviders, registeredOnchainProviders, reserveAdapterIds } from "../../../plugins/registry";

/**
 * Every wallet provider built into Ghostly. Adding one is adding its module next to this file and ONE
 * line in the list of its kind; see PROVIDERS.md. The order is the order of the source picker. A
 * provider written outside the app registers through `plugins/registry.ts` (the SDK) instead, and
 * comes after these.
 */
export const LIGHTNING_PROVIDERS: readonly LightningProviderDescriptor[] = [
  cashuMint,
  fedimint,
  breez,
  nwc,
  coreLightning,
  webln,
  lnd,
];

export const ONCHAIN_PROVIDERS: readonly OnchainProviderDescriptor[] = [
  bitcoindRpc,
  bdk,
];

reserveAdapterIds("lightning", LIGHTNING_PROVIDERS.map((d) => d.id));
reserveAdapterIds("onchain", ONCHAIN_PROVIDERS.map((d) => d.id));

export interface ProviderRegistry {
  readonly lightning: readonly LightningProviderDescriptor[];
  readonly onchain: readonly OnchainProviderDescriptor[];
}

/** A registered provider whose id a built-in owns is dropped (and said so once): the built-in wins. */
const warned = new Set<string>();
function external<D extends { id: string }>(kind: string, builtIn: readonly D[], registered: readonly D[]): D[] {
  return registered.filter((d) => {
    const taken = builtIn.some((b) => b.id === d.id);
    if (taken && !warned.has(`${kind}:${d.id}`)) { warned.add(`${kind}:${d.id}`); console.error(`[ghostly] ${kind} provider ${d.id} from a plugin is ignored: a built-in has that id`); }
    return !taken;
  });
}

/**
 * The built-in providers, then the ones plugins registered, then the fakes when this browser asked
 * for them (e2e). Read each time: a plugin registering later shows up on the next read.
 */
export function defaultRegistry(): ProviderRegistry {
  return {
    get lightning() { return [...LIGHTNING_PROVIDERS, ...external("lightning", LIGHTNING_PROVIDERS, registeredLightningProviders()), ...(testProvidersEnabled() ? [fakeLightning] : [])]; },
    get onchain() { return [...ONCHAIN_PROVIDERS, ...external("onchain", ONCHAIN_PROVIDERS, registeredOnchainProviders()), ...(testProvidersEnabled() ? [fakeOnchain] : [])]; },
  };
}

export { offeredIn };
