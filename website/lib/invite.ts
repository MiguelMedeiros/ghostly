/**
 * Reads a `ghostly1` invite the way the app does (WISP 801, "Reading an invite";
 * packages/core/src/invite.ts `readInviteCode`), for the join page on
 * ghostly.tools/#ghostly1…. The site cannot import the app's core (its build
 * root is website/), so this is a copy of the rules for `ghostly1` codes only,
 * with no dependency; packages/core/test/websiteInvite.test.ts keeps the two
 * in step. Older codes never came to this host, so they are not read here.
 */

export type InviteRefusal = "typo" | "update" | "not-ghostly" | "damaged";
export type InviteCheck = { ok: true; code: string } | { ok: false; reason: InviteRefusal };

const HRP = "ghostly";
const MAX_LENGTH = 1023;
const V1_BYTES = 128;
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32M = 0x2bc830a3;
const BECH32 = 1;

function polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
  }
  return chk >>> 0;
}

function expand(hrp: string): number[] {
  const out: number[] = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}

/** The payload's byte count, or null when its padding is not canonical (more than 4 bits, or not zero). */
function payloadBytes(words: number[]): number | null {
  const bits = words.length * 5;
  const pad = bits % 8;
  if (pad > 4) return null;
  if (pad && (words[words.length - 1] & ((1 << pad) - 1)) !== 0) return null;
  return Math.floor(bits / 8);
}

/** Is this fragment meant as an invite? Anything starting `ghostly1`, in any case. */
export function looksLikeInvite(fragment: string): boolean {
  return /^ghostly1/i.test(fragment.trim());
}

/** The same reasons, in the same order, as the app. `code` comes back in lower case. */
export function checkInvite(input: string): InviteCheck {
  const code = input.trim().replace(/^.*#/, "").toLowerCase();
  if (!code.startsWith(`${HRP}1`)) return { ok: false, reason: "not-ghostly" };
  if (code.length > MAX_LENGTH) return { ok: false, reason: "not-ghostly" };
  const data: number[] = [];
  for (const c of code.slice(HRP.length + 1)) {
    const v = CHARSET.indexOf(c);
    if (v < 0) return { ok: false, reason: "typo" };
    data.push(v);
  }
  if (data.length < 6) return { ok: false, reason: "typo" };
  const sum = polymod([...expand(HRP), ...data]);
  if (sum === BECH32) return { ok: false, reason: "not-ghostly" };
  if (sum !== BECH32M) return { ok: false, reason: "typo" };
  const [version, ...payload] = data.slice(0, -6);
  if (version === undefined || version === 0) return { ok: false, reason: "not-ghostly" };
  if (version !== 1) return { ok: false, reason: "update" };
  if (payloadBytes(payload) !== V1_BYTES) return { ok: false, reason: "damaged" };
  return { ok: true, code };
}
