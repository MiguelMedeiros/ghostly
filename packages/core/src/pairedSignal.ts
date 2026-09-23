import { fromBase64Url, toBase64Url, utf8Encode } from "./bytes";
import { identityFromSeedB64, publicKeyFromZ32, sign, verify } from "./identity";
import { parseRtcSignal } from "./signal";

const transcript = (signal: string, from: string, to: string) =>
  utf8Encode(JSON.stringify(["ghostly-paired-signal", 1, from, to, JSON.parse(signal)]));

/** Sign the existing compact signal, including its timestamp and DTLS binding.
 * Extra fields remain readable by first-increment clients during migration. */
export function signPairedSignal(signal: string, seed: string, from: string, to: string): string {
  const parsed = parseRtcSignal(signal);
  if (!parsed) throw new Error("Invalid outgoing signal");
  const canonical = JSON.stringify(parsed);
  const identity = identityFromSeedB64(seed);
  return JSON.stringify({ ...parsed, auth: { key: identity.pubKeyZ32,
    sig: toBase64Url(sign(transcript(canonical, from, to), identity.seed)) } });
}

/** Invalid input never reaches DataLink's timestamp/glare/SDP state machine. */
export function verifyPairedSignal(signal: string, from: string, to: string,
  peerKey?: string, required = false): string | null {
  try {
    if (signal.length > 4096) return null;
    const raw = JSON.parse(signal);
    const parsed = parseRtcSignal(signal);
    if (!parsed) return null;
    if (!raw.auth) return required ? null : JSON.stringify(parsed);
    const { key, sig } = raw.auth;
    if (typeof key !== "string" || typeof sig !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(sig) ||
      (peerKey && key !== peerKey)) return null;
    const canonical = JSON.stringify(parsed);
    return verify(fromBase64Url(sig), transcript(canonical, from, to), publicKeyFromZ32(key)) ? canonical : null;
  } catch { return null; }
}


/** Keep at least one candidate. Drop duplicate candidate types first; if still
 * necessary prefer relay/server-reflexive reachability over another host route.
 * Every resulting set is signed afresh, never truncated after authentication. */
export function fitSignedPairedSignal(signal: string, seed: string, from: string, to: string,
  fits: (signed: string) => boolean): string {
  const parsed = parseRtcSignal(signal);
  if (!parsed) throw new Error("Invalid outgoing signal");
  for (;;) {
    const signed = signPairedSignal(JSON.stringify(parsed), seed, from, to);
    if (fits(signed)) return signed;
    if (parsed.c.length <= 1) throw new Error("Signed connection details exceed the discovery packet budget");
    let remove = -1;
    for (const type of ["h", "s", "r"]) {
      const indexes = parsed.c.map((c, i) => c.startsWith(`${type},`) ? i : -1).filter(i => i >= 0);
      if (indexes.length > 1) { remove = indexes[indexes.length - 1]; break; }
    }
    if (remove < 0) remove = parsed.c.findIndex(c => c.startsWith("h,"));
    if (remove < 0) remove = parsed.c.findIndex(c => c.startsWith("s,"));
    parsed.c.splice(remove < 0 ? parsed.c.length - 1 : remove, 1);
  }
}
