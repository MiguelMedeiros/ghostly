import { validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import type { WalletMode } from "../../../shared/mints";
import type { OnchainProviderDescriptor } from "./onchain";
import type { ProviderSettings } from "./types";

/**
 * The BDK wallet as the source picker lists it, and its settings, checked before anything is contacted. The wallet
 * (`./bdk`) and BDK's WebAssembly load when one opens, not with the app.
 */

export type BdkNetwork = "regtest" | "signet" | "mutinynet";
export const BDK_NETWORKS: readonly BdkNetwork[] = ["signet", "mutinynet", "regtest"];
/**
 * Public Esplora servers that answer browsers (CORS), tried together when the field is left blank: the
 * first one on the right chain is used. Regtest has none: it is always your own. mempool.space is not the
 * first because it does not answer from every network (it did not from the maintainer's).
 */
export const PUBLIC_ESPLORA: Record<BdkNetwork, readonly string[]> = {
  signet: ["https://blockstream.info/signet/api", "https://mempool.space/signet/api"],
  mutinynet: ["https://mutinynet.com/api"],
  regtest: [],
};
export type BdkScript = "bip84" | "bip86";
export const SCRIPT: Record<BdkScript, { type: "p2wpkh" | "p2tr"; label: string }> = { bip84: { type: "p2wpkh", label: "BIP84" }, bip86: { type: "p2tr", label: "BIP86" } };

export interface BdkConfig {
  network: BdkNetwork;
  /** The server typed in, else the first public one of the network. */
  esplora: string;
  /** Where to look for the chain: the one typed in, or every public server of the network. */
  servers: readonly string[];
  script: BdkScript;
}

/** Checks the settings before anything is contacted. */
export function parseBdkSettings({ config, secrets }: ProviderSettings): BdkConfig & { mnemonic: string } {
  const network = config.network as BdkNetwork;
  if (!BDK_NETWORKS.includes(network)) throw new Error("Choose a test network: Signet, Mutinynet or Regtest");
  const script = (config.script || "bip84") as BdkScript;
  if (!(script in SCRIPT)) throw new Error("Choose BIP84 or BIP86");
  const typed = (config.esplora ?? "").trim().replace(/\/+$/, "");
  const servers = typed ? [typed] : PUBLIC_ESPLORA[network];
  if (!servers.length) throw new Error("Regtest needs the address of your own Esplora server");
  if (typed) {
    let url: URL;
    try { url = new URL(typed); } catch { throw new Error("The Esplora address is not a URL"); }
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocal(url))) throw new Error("The Esplora server must use HTTPS (plain HTTP only on this computer)");
    if (url.username || url.password) throw new Error("Put no credentials in the Esplora address");
  }
  const mnemonic = (secrets.mnemonic ?? "").trim().toLowerCase().split(/\s+/).join(" ");
  if (!validateMnemonic(mnemonic, wordlist)) throw new Error("That recovery phrase is not valid (BIP39, English)");
  return { network, esplora: servers[0], servers, script, mnemonic };
}

export const isLocal = (url: URL) => ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);

const FIELDS = [
  { name: "network", label: "Network", kind: "select", options: [{ value: "signet", label: "Signet" }, { value: "mutinynet", label: "Mutinynet" }, { value: "regtest", label: "Regtest" }], defaults: { testnet: "signet" } },
  { name: "esplora", label: "Esplora server", kind: "url", optional: true, changeable: true, placeholder: "Blank: a public server of the network",
    help: "Blank: the public servers of Signet (blockstream.info, mempool.space) or Mutinynet (mutinynet.com), whichever answers. Regtest needs your own; it must allow this app's origin (CORS).",
    suggestions: [
      ...PUBLIC_ESPLORA.signet.map((value) => ({ value, label: `${new URL(value).host} (Signet)`, when: { network: "signet" } })),
      ...PUBLIC_ESPLORA.mutinynet.map((value) => ({ value, label: `${new URL(value).host} (Mutinynet)`, when: { network: "mutinynet" } })),
      { value: "http://127.0.0.1:47002", label: "This computer: the e2e regtest stack (npm run e2e:infra:up)", when: { network: "regtest" } },
    ] },
  { name: "script", label: "Addresses", kind: "select", options: [{ value: "bip84", label: "Native SegWit (BIP84, bc1q…)" }, { value: "bip86", label: "Taproot (BIP86, bc1p…)" }] },
  { name: "mnemonic", label: "Recovery phrase", kind: "secret", placeholder: "twelve or twenty-four words", help: "BIP39, English. Leave it to Ghostly to make a new wallet, or type yours to restore one." },
] as const satisfies OnchainProviderDescriptor["fields"];

export const bdk: OnchainProviderDescriptor = {
  id: "bdk",
  label: "BDK wallet",
  kind: "onchain",
  description: "A Bitcoin wallet in this app (bitcoindevkit): you hold the keys, an Esplora server tells it the chain. Test networks only for now.",
  // Mainnet waits: no backup of the phrase from the app yet, and no RBF / fee bump for a stuck payment.
  networks: ["signet", "mutinynet", "regtest"],
  platforms: ["web", "extension", "desktop"],
  fields: FIELDS,
  experimental: true,
  validate(settings: ProviderSettings, mode: WalletMode) {
    if (mode !== "testnet") throw new Error("The BDK wallet runs on test networks only for now");
    parseBdkSettings(settings);
  },
  async create(settings, host) {
    const { BdkOnchain } = await import("./bdk");
    return BdkOnchain.open(settings, host);
  },
};
