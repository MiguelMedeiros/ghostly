import { LIGHTNING_PROVIDERS, ONCHAIN_PROVIDERS } from "@ghostly/browser/engine/paymentAdapters/providers/registry";
import type { SourceView } from "@ghostly/browser/engine/paymentAdapters/providers/sources";
import { describeProvider, offeredIn, type ProviderDescriptor, type ProviderDescriptorView } from "@ghostly/browser/engine/paymentAdapters/providers/types";

/**
 * The built-in providers as the engine hands them to the UI (`describeProvider`), so the tests follow the
 * real fields: a provider that changes its form changes what these tests type.
 */
const ALL = [...LIGHTNING_PROVIDERS, ...ONCHAIN_PROVIDERS] as unknown as ProviderDescriptor<unknown>[];

export function descriptor(id: string): ProviderDescriptorView {
  const found = ALL.find((d) => d.id === id);
  if (!found) throw new Error(`No built-in provider ${id}`);
  return describeProvider(found);
}

/** What the engine offers in the web app for this kind and mode, in registry order. */
export function offered(kind: "lightning" | "onchain", mode: "mainnet" | "testnet"): ProviderDescriptorView[] {
  const list = (kind === "lightning" ? LIGHTNING_PROVIDERS : ONCHAIN_PROVIDERS) as unknown as ProviderDescriptor<unknown>[];
  return list.filter((d) => offeredIn(d, "web", mode)).map(describeProvider);
}

/** A source view as the engine reports it: nothing set up unless the patch says so. */
export function sourceView(patch: Partial<SourceView> & Pick<SourceView, "offered">): SourceView {
  return { mode: "mainnet", status: "none", ...patch };
}
