import type { BitcoinNetwork } from "@ghostly/core";
import type { WalletMode } from "../../../shared/mints";

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
export const PROVIDER_NETWORKS: readonly ProviderNetwork[] = ["bitcoin", "signet", "testnet", "regtest", "mutinynet"];
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
  /**
   * Reserved for the built-in Cashu mint source: the engine's own wallet. It is not part of the SDK, and
   * no other provider should read it.
   */
  cashu?: unknown;
  /** Ends when the source is replaced, the mode switches or the engine stops: abort long waits on it. */
  signal: AbortSignal;
  /**
   * Desktop only: calls a command of the Tauri app (src-tauri), for what a WebView cannot do (a pinned
   * certificate, no CORS, a raw socket). Absent on the web and in the extension.
   */
  invoke?: <T>(command: string, args: Record<string, unknown>) => Promise<T>;
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

/** A provider can be offered here: it runs on this platform and on a network of this mode. */
export const offeredIn = (descriptor: { platforms: readonly ProviderPlatform[]; networks: readonly ProviderNetwork[] }, platform: ProviderPlatform, mode: WalletMode) =>
  descriptor.platforms.includes(platform) && descriptor.networks.some((network) => networkMode(network) === mode);

const FIELD_KINDS = ["text", "url", "secret", "select", "textarea"];
/** What is stored with the profile and sent on the wire in journals: stable, short, lowercase. */
export const PROVIDER_ID = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * Problems with a provider descriptor, empty when it is well-formed. The registry refuses a descriptor
 * with any; the contract suite checks the same list, so an author sees them before the app does.
 */
export function providerDescriptorProblems(d: ProviderDescriptor<unknown>): string[] {
  const problems: string[] = [];
  if (!PROVIDER_ID.test(d.id ?? "")) problems.push("id must match ^[a-z][a-z0-9-]{0,31}$");
  if (!d.label?.trim()) problems.push("label is empty");
  if (d.kind !== "lightning" && d.kind !== "onchain") problems.push("kind must be lightning or onchain");
  if (!d.description?.trim()) problems.push("description is empty: say what it is and who holds the money");
  if (!Array.isArray(d.networks) || !d.networks.length) problems.push("no networks");
  else for (const n of d.networks) if (!PROVIDER_NETWORKS.includes(n)) problems.push(`unknown network ${String(n)}`);
  if (!Array.isArray(d.platforms) || !d.platforms.length) problems.push("no platforms");
  else for (const p of d.platforms) if (!PROVIDER_PLATFORMS.includes(p)) problems.push(`unknown platform ${String(p)}`);
  if (!Array.isArray(d.fields)) problems.push("fields must be a list (empty when there is nothing to configure)");
  else {
    const names = d.fields.map((f) => f.name);
    if (new Set(names).size !== names.length) problems.push("field names are not unique");
    for (const f of d.fields) {
      if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(f.name ?? "")) problems.push(`field ${String(f.name)} has an invalid name`);
      if (!f.label?.trim()) problems.push(`field ${f.name} has no label`);
      if (!FIELD_KINDS.includes(f.kind)) problems.push(`field ${f.name} has an unknown kind`);
      if (f.kind === "select" && !f.options?.length) problems.push(`field ${f.name} is a select without options`);
    }
  }
  if (typeof d.create !== "function") problems.push("create is not a function");
  if (d.validate !== undefined && typeof d.validate !== "function") problems.push("validate is not a function");
  return problems;
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
 * Whether an error says nothing was spent. By name, not by class: a provider built outside the app (an
 * SDK plugin bundled with its own copy of `NothingSpentError`) must be understood the same way.
 */
export const isNothingSpentError = (error: unknown): error is NothingSpentError =>
  error instanceof NothingSpentError || (error instanceof Error && error.name === "NothingSpentError");

/**
 * An error message fit to show and store: every secret the source was given is blanked out, in case a
 * library echoed a URI or a key back.
 */
export function redact(error: unknown, secrets: Record<string, string> = {}): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const value of Object.values(secrets)) if (value && value.length >= 4) message = message.split(value).join("•••");
  return message.slice(0, 300);
}
