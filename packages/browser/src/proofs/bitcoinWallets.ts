import type { BitcoinScriptType } from "@ghostly/core";

/**
 * Person-facing steps to sign Ghostly's proof statement for a Bitcoin address, per common wallet: which
 * menu, what to paste where, which format to pick. Ghostly never sees the wallet or its keys; the person
 * pastes the signature back.
 *
 * Only what each wallet's own documentation or UI shows is claimed here. Hardware wallets differ by model
 * and firmware (ADAPTER-ROADMAP.md, "Hardware and signing"); their entries point to the vendor's guide.
 */

export type BitcoinSigningFormat = "bip322" | "legacy";

export interface BitcoinWalletGuide {
  id: string;
  name: string;
  /** Address types this wallet can sign for in a format Ghostly accepts. */
  scripts: readonly BitcoinScriptType[];
  format: BitcoinSigningFormat;
  steps: readonly string[];
  /** How to use the test networks, for Testnet mode. */
  testnet?: string;
  note?: string;
  docs?: string;
}

/** What a proof proves and what it does not; shown next to every Bitcoin proof, given or received. */
export const BITCOIN_PROOF_LIMITS = [
  "Proves: whoever made this signature could sign with the key behind this address when they signed.",
  "Does not prove the address holds any balance, now or ever.",
  "Does not prove they sent or received any past payment.",
  "Does not prove they would pay you, or spend from this address at all.",
] as const;

export const BITCOIN_WALLET_GUIDES: readonly BitcoinWalletGuide[] = [
  {
    id: "sparrow",
    name: "Sparrow Wallet",
    scripts: ["p2wpkh", "p2tr", "p2pkh"],
    format: "bip322",
    steps: [
      "Open the wallet that holds the address, then Tools → Sign/Verify Message.",
      "Address: paste the address you are proving.",
      "Message: paste the statement Ghostly shows, exactly as it is.",
      "Format: BIP322 (Simple) for a bc1q… or bc1p… address (tb1… on test networks). For a legacy 1… address, Standard (Electrum).",
      "Sign Message, then copy the whole Signature (it starts with smp…) and paste it into Ghostly.",
    ],
    testnet: "Tools → Restart In → Testnet or Signet, with a wallet on that network.",
    note: "Sparrow offers BIP322 (Simple) for software wallets only; a connected hardware wallet signs the Standard (Electrum) format, which Ghostly accepts only for a legacy 1… address.",
    docs: "https://sparrowwallet.com/docs/",
  },
  {
    id: "bitcoin-core",
    name: "Bitcoin Core",
    scripts: ["p2pkh"],
    format: "legacy",
    steps: [
      "Bitcoin Core signs messages in the legacy format only, for a legacy address (1… on mainnet, m… or n… on test networks). Make one in the Receive tab with the Base58 (Legacy) type, or with `getnewaddress \"\" legacy`.",
      "GUI: File → Sign message…; paste the address, paste the statement, Sign Message, copy the signature.",
      "Command line: bitcoin-cli signmessage \"<address>\" '<statement>' (single quotes keep the statement's double quotes intact).",
    ],
    testnet: "Run it with -signet, -testnet4 or -regtest; add the same flag to bitcoin-cli.",
    docs: "https://developer.bitcoin.org/reference/rpc/signmessage.html",
  },
  {
    id: "electrum",
    name: "Electrum",
    scripts: ["p2pkh"],
    format: "legacy",
    steps: [
      "Electrum signs in the legacy format, which Ghostly accepts only for a legacy 1… address (m…/n… on test networks); its default bc1… wallets need another wallet.",
      "Addresses tab (View → Show Addresses), right-click the address → Sign/verify message.",
      "Paste the statement into Message, click Sign, copy the Signature and paste it into Ghostly.",
    ],
    testnet: "Start Electrum with --testnet or --signet.",
    docs: "https://electrum.readthedocs.io/",
  },
  {
    id: "coldcard",
    name: "COLDCARD",
    scripts: ["p2wpkh", "p2tr", "p2pkh"],
    format: "bip322",
    steps: [
      "Follow COLDCARD's BIP-322 guide for your firmware: it signs the statement for one of its addresses via MicroSD, NFC or QR, depending on the model.",
      "Give it the statement exactly as Ghostly shows it and the address you are proving.",
      "Paste the signature it produces into Ghostly.",
    ],
    note: "Older firmware signs only the legacy format (Ghostly accepts that for a legacy 1… address) and limits message length and characters.",
    docs: "https://coldcard.com/docs/bip322/",
  },
  {
    id: "trezor",
    name: "Trezor Suite",
    scripts: ["p2pkh"],
    format: "legacy",
    steps: [
      "Trezor signs messages in the legacy format; Ghostly accepts it for an address of a Legacy account (1…).",
      "Open the Legacy account and choose Sign & verify in its menu.",
      "Paste the statement into Message, pick the address, Sign, confirm on the device, copy the signature into Ghostly.",
    ],
  },
  {
    id: "other",
    name: "Another wallet",
    scripts: ["p2wpkh", "p2tr", "p2sh", "p2pkh"],
    format: "bip322",
    steps: [
      "Look for \"Sign message\" in the wallet. Choose BIP-322 when it asks for a format.",
      "Sign the statement exactly as Ghostly shows it, with the address you are proving.",
      "A nested SegWit address (3…, or 2… on test networks) needs a full BIP-322 signature (it starts with ful…).",
      "Paste the signature into Ghostly; it tells you right away if it does not match.",
    ],
  },
];

/** The guides that can sign for an address of this type. */
export function guidesFor(script: BitcoinScriptType): BitcoinWalletGuide[] {
  return BITCOIN_WALLET_GUIDES.filter(g => g.scripts.includes(script));
}
