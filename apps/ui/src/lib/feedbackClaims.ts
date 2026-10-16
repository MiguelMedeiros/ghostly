/**
 * Extension pages may share one engine: one presentation (a sound, a notification) per attention event, claimed under
 * a key of its own, a short hash of the event's id, for as long as an event can still be presented. It was one list of
 * the last 256 ids, read and written whole for every event (29 K characters a message in a group, sent to every other
 * open page too).
 */
const CLAIM = "ghostly_feedback_claim:";
/** How long a claim is kept: an event older than 5 s is never presented (AttentionFeedback). */
const CLAIM_MS = 10_000;
/** Every this many claims, the old ones are dropped. */
const DROP_EVERY = 64;
let claimed = 0;
try { localStorage.removeItem("ghostly_feedback_claims"); } catch { /* unavailable */ }

/** The key that claims an event: its id hashed to 53 bits (cyrb53), so one claim is a few dozen characters. */
export function feedbackClaimKey(id: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < id.length; i++) {
    const c = id.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return CLAIM + (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** Claims an event for this page: false when another page has. Called under the `ghostly-feedback` lock where there is one. */
export function claimFeedback(id: string, now: number): boolean {
  const key = feedbackClaimKey(id);
  try {
    if (localStorage.getItem(key) !== null) return false;
    localStorage.setItem(key, String(now));
    if (++claimed % DROP_EVERY === 0) {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const old = localStorage.key(i);
        if (old?.startsWith(CLAIM) && !(now - Number(localStorage.getItem(old)) < CLAIM_MS)) localStorage.removeItem(old);
      }
    }
  } catch { /* unavailable: the page's own dedupe still applies */ }
  return true;
}
