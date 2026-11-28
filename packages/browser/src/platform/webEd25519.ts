import { identityFromSeed, setAsyncVerifyFastPath, sign, toBase64Url, utf8Encode, type AsyncVerifyFastPath } from "@ghostly/core";

/** The most keys held imported: a community's 256 members, with room for the other chats' signers. */
const KEYS_MAX = 1024;

/** WebCrypto's Ed25519 check, each key imported once: the same members sign frame after frame. */
export function webCryptoEd25519(subtle: SubtleCrypto): AsyncVerifyFastPath {
  const keys = new Map<string, Promise<CryptoKey>>();
  return async (signature, message, publicKey) => {
    const id = toBase64Url(publicKey);
    let key = keys.get(id);
    if (!key) {
      key = subtle.importKey("raw", new Uint8Array(publicKey), { name: "Ed25519" }, false, ["verify"]);
      if (keys.size >= KEYS_MAX) keys.clear();
      keys.set(id, key);
      key.catch(() => { if (keys.get(id) === key) keys.delete(id); });
    }
    return subtle.verify({ name: "Ed25519" }, await key, new Uint8Array(signature), new Uint8Array(message));
  };
}

/**
 * Gives the engine's async signature checks (`verifyAsync`, a community's frames) to this page's WebCrypto, where it has
 * Ed25519 (Chrome 137+, Firefox 129+, Safari 17+) and it says yes to a good signature and no to a bad one. Elsewhere
 * nothing changes: noble's check answers, as before. Whether the check was given.
 */
export async function installWebEd25519(subtle: SubtleCrypto | null = globalThis.crypto?.subtle ?? null): Promise<boolean> {
  if (!subtle) return false;
  const check = webCryptoEd25519(subtle);
  try {
    const seed = new Uint8Array(32).fill(7);
    const { publicKey } = identityFromSeed(seed);
    const message = utf8Encode("an Ed25519 check that answers as it should");
    const good = sign(message, seed);
    const bad = Uint8Array.from(good);
    bad[40] ^= 1;
    if (await check(good, message, publicKey) !== true) return false;
    if (await check(bad, message, publicKey).catch(() => false) !== false) return false;
  } catch {
    return false;
  }
  setAsyncVerifyFastPath(check);
  return true;
}
