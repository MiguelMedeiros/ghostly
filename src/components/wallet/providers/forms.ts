import type { ComponentType } from "react";
import type { ProviderDescriptorView } from "@ghostly/browser/engine/paymentAdapters/providers/types";
import { BdkForm } from "./BdkForm";
import { BreezForm } from "./BreezForm";
import { FedimintForm } from "./FedimintForm";
import { WeblnForm } from "./WeblnForm";

/** What a provider's own configuration form gets. It calls `onSubmit` with the values of its fields. */
export interface ProviderFormProps {
  descriptor: ProviderDescriptorView;
  mode: "mainnet" | "testnet";
  busy: boolean;
  onSubmit(values: Record<string, string>): void;
}

/**
 * Providers whose form is more than their declared fields (a "Connect" button that asks a browser
 * wallet, a QR scanner for a connection URI…) register their component here, by provider id. Every
 * other provider gets the generic form built from its `fields`. See PROVIDERS.md.
 */
export const PROVIDER_FORMS: Record<string, ComponentType<ProviderFormProps>> = {
  bdk: BdkForm,
  breez: BreezForm,
  fedimint: FedimintForm,
  webln: WeblnForm,
};
