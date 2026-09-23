import { BitcoinAddressError, decodeAnyBitcoinAddress, verifyBitcoinMessage, type BitcoinMessageVerdict, type BitcoinProofNetwork, type BitcoinScriptType, type IdentityStatement } from "@ghostly/core";
import type { ExternalToolSigner, IdentityProofProvider, InstructionStep } from "../contract";
import { BITCOIN_PROOF_LIMITS, BITCOIN_WALLET_GUIDES, guidesFor, type BitcoinWalletGuide } from "../bitcoinWallets";

/**
 * Bitcoin address proofs: the person signs the statement with the key behind an address, in their own
 * wallet, and pastes the signature. BIP-322 (simple or full) or, for a legacy P2PKH address only, the
 * legacy `signmessage` format; checked on this device by `verifyBitcoinMessage` (@ghostly/core, pinned to
 * BIP-322 2.0.0). No blockchain lookup: the proof says nothing about coins. See
 * docs/wisps/3xx-bitcoin.md.
 *
 * The address's own prefix says its network: a proof for a test-network address (tb1…, bcrt1…, m…, n…, 2…)
 * is verified as such and labelled "test network" wherever it is shown.
 *
 * TODO(ghostly-wallet signer): "Sign with my Ghostly wallet" belongs here as an `in-app` signer once an
 * on-chain source can sign messages. `OnchainProvider` (engine/paymentAdapters/providers/onchain.ts) has
 * no such method today; Bitcoin Core's `signmessage` works for legacy addresses only and BDK exposes no
 * message signing. It must show the statement and ask before signing, never sign silently.
 */

export interface BitcoinEvidence {
  /** As the wallet printed it: `smp…`/`ful…`, unprefixed BIP-322, or a legacy base64 signature. */
  signature: string;
}

const MAX_SIGNATURE = 8192;
const SIGNATURE = /^(smp|ful|pof)?[A-Za-z0-9+/]+={0,2}$/;

const SCRIPT_NAMES: Record<BitcoinScriptType, string> = {
  p2wpkh: "native SegWit (bc1q…)", p2tr: "Taproot (bc1p…)", p2sh: "nested SegWit (3…)", p2pkh: "legacy (1…)",
  p2wsh: "script / multisig (P2WSH)", "witness-unknown": "future SegWit version",
};

function normalizeAddress(input: string): string {
  const value = input.trim();
  let info;
  try { info = decodeAnyBitcoinAddress(value); } catch (e) {
    throw new Error(e instanceof BitcoinAddressError ? e.message : "Enter a Bitcoin address", { cause: e });
  }
  if (info.type === "p2wsh" || info.type === "witness-unknown")
    throw new Error("Ghostly can check proofs for single-key addresses only (bc1q…, bc1p…, 3…, 1…), not multisig or script addresses");
  // Bech32 may be written in upper case; its canonical form is lower case. Base58 is case-sensitive.
  return info.witnessVersion === undefined ? value : value.toLowerCase();
}

const isTestAddress = (address: string) => { try { return decodeAnyBitcoinAddress(address).network === "testnet"; } catch { return false; } };

function shortAddress(address: string): string {
  return `${address.slice(0, address.startsWith("bcrt1") ? 9 : 7)}…${address.slice(-4)}${isTestAddress(address) ? " · test network" : ""}`;
}

/** Wallet steps for this statement's address: the guide's own, or why this wallet cannot sign for it. */
function walletInstructions(guide: BitcoinWalletGuide, statement: IdentityStatement) {
  const address = statement.binding.subject;
  const info = decodeAnyBitcoinAddress(address);
  const steps: InstructionStep[] = [];
  if (!guide.scripts.includes(info.type)) {
    const others = guidesFor(info.type).filter(g => g.id !== "other").map(g => g.name);
    steps.push({ text: `${guide.name} cannot sign for a ${SCRIPT_NAMES[info.type]} address in a format Ghostly accepts.${others.length ? ` Try ${others.join(" or ")}, or another wallet that signs BIP-322.` : " Use a wallet that signs BIP-322."}` });
  } else {
    steps.push({ text: "Sign exactly this statement, as one line, without adding a line break:", copy: statement.text });
    steps.push({ text: "With this address:", copy: address });
    for (const text of guide.steps) steps.push({ text });
    if (guide.id === "bitcoin-core") steps.push({ text: `Command line${info.network === "testnet" ? " (add -signet, -testnet4 or -regtest)" : ""}:`, copy: `bitcoin-cli signmessage "${address}" '${statement.text}'` });
    if (info.network === "testnet" && guide.testnet) steps.push({ text: `Test networks: ${guide.testnet}` });
    if (guide.note) steps.push({ text: guide.note });
  }
  steps.push({ text: "This shows you can sign for the address. It does not show a balance, a past payment, or that you would pay." });
  return { steps, paste: { label: "Signature", placeholder: "smp… (BIP-322) or the base64 signature your wallet shows", multiline: true } };
}

function cleanSignature(pasted: string): string {
  const signature = pasted.replace(/\s+/g, "");
  if (!signature) throw new Error("Paste the signature your wallet made");
  if (signature.length > MAX_SIGNATURE || !SIGNATURE.test(signature)) throw new Error("That is not a Bitcoin message signature: paste the whole signature, as the wallet shows it");
  return signature;
}

function check(statement: IdentityStatement, signature: string): { verdict: Extract<BitcoinMessageVerdict, { state: "valid" }>; network: BitcoinProofNetwork } {
  const address = statement.binding.subject;
  const network = decodeAnyBitcoinAddress(address).network;
  const verdict = verifyBitcoinMessage({ address, message: statement.text, signature, network });
  if (verdict.state !== "valid") throw new Error(verdict.reason);
  return { verdict, network };
}

function walletSigner(guide: BitcoinWalletGuide): ExternalToolSigner<BitcoinEvidence> {
  return {
    id: guide.id, kind: "external-tool", label: guide.name,
    description: guide.format === "legacy" ? "Legacy message signature: for a legacy 1… address only." : "BIP-322 message signature.",
    instructions: statement => walletInstructions(guide, statement),
    parse(pasted, statement) {
      const signature = cleanSignature(pasted);
      // Say right away when it does not match, while the wallet is still open.
      check(statement, signature);
      return { signature };
    },
  };
}

export const bitcoin: IdentityProofProvider<BitcoinEvidence> = {
  id: "bitcoin",
  label: "Bitcoin address",
  category: "self-custodied",
  description: "Proves you can sign with the key behind a Bitcoin address, in your own wallet. It does not prove a balance, a past payment, or that you would pay.",
  platforms: ["web", "extension", "desktop"],
  subject: {
    label: "Bitcoin address",
    placeholder: "bc1q… (tb1… on test networks)",
    help: BITCOIN_PROOF_LIMITS.join(" "),
    normalize: normalizeAddress,
    short: shortAddress,
  },
  validity: { defaultDays: 90, maxDays: 365 },
  privacy: "Nothing: the signature is checked on this device, with no blockchain lookup. Contacts you share it with learn the address.",
  signers: BITCOIN_WALLET_GUIDES.map(walletSigner),
  parseEvidence(raw) {
    const e = raw as BitcoinEvidence;
    if (!e || typeof e !== "object" || Array.isArray(e) || Object.keys(e).join(",") !== "signature" || typeof e.signature !== "string" ||
      e.signature.length > MAX_SIGNATURE || !SIGNATURE.test(e.signature)) throw new Error("That is not a Bitcoin message signature");
    return { signature: e.signature };
  },
  async verify(statement, evidence) {
    const { verdict, network } = check(statement, evidence.signature);
    const format = verdict.format === "legacy" ? "Legacy signmessage" : verdict.format === "bip322-full" ? "BIP-322 full" : "BIP-322 simple";
    const script = { p2pkh: "P2PKH", p2wpkh: "P2WPKH", "p2sh-p2wpkh": "P2SH-P2WPKH", p2tr: "P2TR" }[verdict.script];
    return { subject: statement.binding.subject, source: `${format} signature, ${script}${network === "testnet" ? ", test network" : ""}` };
  },
};
