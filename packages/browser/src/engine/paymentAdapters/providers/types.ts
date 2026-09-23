import type { BitcoinNetwork } from "@ghostly/core";
import type { WalletMode } from "../../../shared/mints";
import type { CashuWallet } from "../../wallet";

/**
 * What every wallet provider (a source of Lightning or of on-chain Bitcoin) shares: where it runs, how
 * it is configured, and the one distinction that keeps money safe. See PROVIDERS.md.
 */

/** Where Ghostly runs: the web app, the browser extension (engine in an offscreen document), the Tauri app. */
export type ProviderPlatform = "web" | "extension" | "desktop";
export const PROVIDER_PLATFORMS: readonly ProviderPlatform[] = ["web", "extension", "desktop"];
export type ProviderKind = "lightning" | "onchain";
/** The chain a provider's sats live on. Only `bitcoin` is real money; the others belong to the Testnet mode. */
export type ProviderNetwork = BitcoinNetwork;
export const networkMode = (network: ProviderNetwork): WalletMode => (network === "bitcoin" ? "mainnet" : "testnet");

/**
 * One field of a provider's configuration form. The wallet card renders these; a provider that needs
 * more registers its own form component instead (src/components/wallet/providers/forms.ts).
 * `secret` fields (an NWC URI, a macaroon, a rune, an API key, a password) are sealed before they are
 * stored, never shown again, never put in the engine state, and never logged.
 */
export interface ProviderField {
  name: string;
  label: string;
  kind: "text" | "url" | "secret" | "select" | "textarea";
  placeholder?: string;
  help?: string;
  optional?: boolean;
  /** `select` only. */
  options?: { value: string; label: string }[];
  /** Pre-filled per mode, e.g. a public test server for Testnet. */
  defaults?: Partial<Record<WalletMode, string>>;
}

/** What the person typed, split by the field kinds: `config` is shown back, `secrets` never is. */
export interface ProviderSettings {
  config: Record<string, string>;
  secrets: Record<string, string>;
}

/** What the engine hands a provider's factory. */
export interface ProviderHost {
  platform: ProviderPlatform;
  /** The wallet mode the source is for: its provider must be on a network of this mode. */
  mode: WalletMode;
  /** The Cashu wallet, for the built-in mint source. Other providers do not need it. */
  cashu: CashuWallet;
  /** Ends when the source is replaced, the mode switches or the engine stops: abort long waits on it. */
  signal: AbortSignal;
}

/**
 * A provider module's export. Registering a provider is adding its module and one line in
 * `registry.ts`; everything else (storage, sealing, per-mode sources, the card, journals) is shared.
 */
export interface ProviderDescriptor<P> {
  id: string;
  label: string;
  kind: ProviderKind;
  /** One line under the name in the source picker: what it is and who holds the money. */
  description: string;
  /** Networks it can run on. A mode lists only providers with a network of that mode. */
  networks: readonly ProviderNetwork[];
  platforms: readonly ProviderPlatform[];
  fields: readonly ProviderField[];
  /** Custodial (someone else holds the sats) or still experimental: said in the picker. */
  custodial?: boolean;
  experimental?: boolean;
  /** Checks the form before anything is contacted; throws a message fit for the person. */
  validate?(settings: ProviderSettings, mode: WalletMode): void;
  /** Connects. The engine then asks `info()` and refuses a network of the other mode. */
  create(settings: ProviderSettings, host: ProviderHost): Promise<P>;
}

/** The serializable part of a descriptor, for the UI (a function cannot cross the extension's port). */
export type ProviderDescriptorView = Omit<ProviderDescriptor<unknown>, "create" | "validate">;
/** Only these fields reach the UI, whatever else a provider module keeps on its descriptor. */
export const describeProvider = ({ id, label, kind, description, networks, platforms, fields, custodial, experimental }: ProviderDescriptor<unknown>): ProviderDescriptorView =>
  ({ id, label, kind, description, networks, platforms, fields, custodial, experimental });

/**
 * The provider proved that nothing left the wallet (refused before sending, no route found before any
 * HTLC, a transaction that was never broadcast). Safe to try again, with this or another source.
 *
 * Any other error from a spend means the outcome is UNKNOWN: the payment may be in flight or done. It is
 * recorded as such and only reconciled (asked about), never retried. When in doubt, do not throw this.
 */
export class NothingSpentError extends Error {
  constructor(message: string) { super(message); this.name = "NothingSpentError"; }
}

/**
 * An error message fit to show and store: every secret the source was given is blanked out, in case a
 * library echoed a URI or a key back.
 */
export function redact(error: unknown, secrets: Record<string, string> = {}): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const value of Object.values(secrets)) if (value && value.length >= 4) message = message.split(value).join("•••");
  return message.slice(0, 300);
}
