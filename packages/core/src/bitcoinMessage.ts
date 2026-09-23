import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesEqual, concatBytes, utf8Encode } from "./bytes";
import { type BitcoinMessageVerdict, MessageRefusal, decodeBase64, verifyBip322 } from "./bip322";
import { type BitcoinProofNetwork, BitcoinAddressError, compactSize, decodeBitcoinAddress, hash160, sha256d } from "./bitcoinScript";

/**
 * Verifies a signed message for a Bitcoin address, in either format wallets produce:
 *
 *   - **BIP-322** (see bip322.ts): `smp…` / `ful…`, or unprefixed from wallets that predate the prefixes.
 *   - **Legacy signmessage** (Bitcoin Core `signmessage`, Electrum, most hardware wallets): a 65-byte
 *     recoverable ECDSA signature. BIP-322 restricts it to **P2PKH** addresses (1…, m…, n…), and so does
 *     this verifier: for SegWit addresses the legacy format does not commit to the script, and wallets
 *     disagree on its header bytes (BIP 137 vs Electrum).
 *
 * A valid result proves the signer could sign for the address when they signed. It does not prove a
 * balance, a past payment, or that they would spend from it.
 */

const MAX_MESSAGE = 16 * 1024;
const MAX_SIGNATURE = 16 * 1024;
const MAGIC = utf8Encode("Bitcoin Signed Message:\n");

/** The digest `signmessage` signs: double SHA-256 of the length-prefixed magic and message. */
export function legacyMessageHash(message: string): Uint8Array {
  const bytes = utf8Encode(message);
  return sha256d(compactSize(MAGIC.length), MAGIC, compactSize(bytes.length), bytes);
}

/** Header bytes 27-34 are P2PKH (uncompressed 27-30, compressed 31-34); 35-42 are BIP 137 SegWit headers. */
export const isLegacySignature = (bytes: Uint8Array) => bytes.length === 65 && bytes[0] >= 27 && bytes[0] <= 42;

function verifyLegacy(address: ReturnType<typeof decodeBitcoinAddress>, message: string, bytes: Uint8Array) {
  if (address.type !== "p2pkh")
    throw new MessageRefusal("invalid", "This is a legacy (signmessage) signature, which Ghostly accepts only for legacy 1…/m…/n… addresses. Sign with BIP-322 for this address.");
  const header = bytes[0];
  if (header > 34) throw new MessageRefusal("invalid", "This legacy signature is marked for a SegWit address, not this one");
  const compressed = header >= 31;
  const recovery = (header - 27) & 3;
  let pubkey: Uint8Array;
  try {
    const point = secp256k1.Signature.fromBytes(concatBytes(Uint8Array.of(recovery), bytes.subarray(1)), "recovered").recoverPublicKey(legacyMessageHash(message));
    pubkey = point.toBytes(compressed);
  } catch { throw new MessageRefusal("invalid", "The signature does not match this address and message"); }
  if (!bytesEqual(hash160(pubkey), address.program)) throw new MessageRefusal("invalid", "The signature does not match this address and message");
}

export interface BitcoinMessageInput {
  address: string;
  message: string;
  signature: string;
  /** Mainnet accepts only real-network addresses; Testnet any test network's (testnet, signet, regtest). */
  network: BitcoinProofNetwork;
}

/** Never throws: every refusal comes back as `invalid` or `inconclusive` with a reason fit to show. */
export function verifyBitcoinMessage({ address, message, signature, network }: BitcoinMessageInput): BitcoinMessageVerdict {
  try {
    if (typeof message !== "string" || typeof signature !== "string" || typeof address !== "string") throw new MessageRefusal("invalid", "Missing address, message or signature");
    if (utf8Encode(message).length > MAX_MESSAGE) throw new MessageRefusal("invalid", "The message is too long");
    const text = signature.trim();
    if (!text) throw new MessageRefusal("invalid", "The signature is empty");
    if (text.length > MAX_SIGNATURE) throw new MessageRefusal("invalid", "The signature is too long");
    const decoded = decodeBitcoinAddress(address.trim(), network);
    const prefixed = /^(smp|ful|pof)/.test(text);
    if (!prefixed) {
      const bytes = decodeBase64(text);
      if (isLegacySignature(bytes)) {
        verifyLegacy(decoded, message, bytes);
        return { state: "valid", format: "legacy", script: "p2pkh" };
      }
    }
    return { state: "valid", ...verifyBip322(decoded, message, text) };
  } catch (e) {
    if (e instanceof MessageRefusal) return { state: e.state, reason: e.message };
    if (e instanceof BitcoinAddressError) return { state: "invalid", reason: e.message };
    return { state: "invalid", reason: "The signature could not be read" };
  }
}
