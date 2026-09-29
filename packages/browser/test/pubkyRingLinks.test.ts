import { describe, expect, it } from "vitest";
import type { ApprovalRequest } from "../src/proofs/contract";
import { PASSPORT_ORIGIN, PUBKY_CLIENT_ID, withPubkyApproval } from "../src/proofs/pubky";
// covers: proofs.pubky

/**
 * The two links one Pubky approval shows, made by the real Pubky SDK: Passport's is a grant request
 * (`pubkyauth://signin_grant?…`), Ring's QR code a cookie request (`pubkyauth://signin?…`), each with its own relay
 * secret. And the guard: the Ring in the app stores reads the QR code as an auth request, where it answered
 * "Unrecognized format" to the grant link.
 */

const CAPABILITY = `/pub/ghostly.app/proofs/${"a1".repeat(32)}/:w` as const;

/** Starts a real request, takes the approval screen it shows, and cancels it before any poll. */
async function links(relay: string): Promise<{ qr: string; passport: string }> {
  const controller = new AbortController();
  let shown: ApprovalRequest | undefined;
  const opened: string[] = [];
  const run = withPubkyApproval({
    capability: CAPABILITY, signal: controller.signal, relay, onProgress: () => {},
    openPassport: url => { opened.push(url); },
    onApproval: request => {
      if (!request) return;
      shown = request;
      request.open!.run();
      controller.abort(new Error("Cancelled"));
    },
  }, async () => { throw new Error("nothing is approved here"); });
  await expect(run).rejects.toThrow(/Cancelled/);
  const passport = new URL(opened[0]);
  expect(`${passport.origin}${passport.pathname}`).toBe(`${PASSPORT_ORIGIN}/authorize`);
  return { qr: shown!.qr!.value, passport: decodeURIComponent(passport.hash.slice("#d=".length)) };
}

const query = (link: string) => new URLSearchParams(link.slice(link.indexOf("?") + 1));

describe("Pubky approval links", () => {
  it("draws a cookie request in Ring's QR code and sends Passport a grant request, each with its own secret", async () => {
    // A relay nobody answers on, so no test traffic leaves the machine.
    const relay = "http://127.0.0.1:9/inbox/";
    const { qr, passport } = await links(relay);

    expect(qr.startsWith("pubkyauth://signin?")).toBe(true);
    const ring = query(qr);
    expect(ring.get("caps")).toBe(CAPABILITY);
    expect(ring.get("relay")).toBe(relay);
    expect(ring.get("secret")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(ring.get("x-source")).toBe("Ghostly");
    expect(ring.has("cid")).toBe(false);
    expect(ring.has("cpk")).toBe(false);

    expect(passport.startsWith("pubkyauth://signin_grant?")).toBe(true);
    const grant = query(passport);
    expect(grant.get("caps")).toBe(CAPABILITY);
    expect(grant.get("relay")).toBe(relay);
    expect(grant.get("cid")).toBe(PUBKY_CLIENT_ID);
    expect(grant.get("cpk")).toBeTruthy();
    expect(grant.get("secret")).toMatch(/^[A-Za-z0-9_-]{43}$/);

    expect(ring.get("secret")).not.toBe(grant.get("secret"));
  });

  it("is read as an auth request by the Pubky Ring in the app stores, which does not know the grant link", async () => {
    const { qr, passport } = await links("http://127.0.0.1:9/inbox/");
    expect(storeRingRoute(qr)).toEqual({ action: "auth", kind: "signin", caps: [CAPABILITY], relay: query(qr).get("relay"), secret: query(qr).get("secret"), xSource: "Ghostly" });
    // The grant link is what it answered "Unrecognized format" to.
    expect(storeRingRoute(passport)).toEqual({ action: "unknown" });
  });

  it("ports the store Ring's rule faithfully (its own link shapes)", () => {
    const secret = "c2VjcmV0LXJlbGF5LWtleS10aGF0LWlzLTMyLWJ5dGVz";
    const relay = "https%3A%2F%2Fhttprelay.pubky.app%2Finbox%2F";
    // Legacy and 0.9 signin links, with the `/?` and pubkyring:// forms it normalizes.
    for (const link of [
      `pubkyauth:///?caps=%2Fpub%2Fexample.com%2F%3Arw&relay=${relay}&secret=${secret}`,
      `pubkyauth://signin?caps=%2Fpub%2Fexample.com%2F%3Arw&relay=${relay}&secret=${secret}`,
      `pubkyauth://signin/?caps=%2Fpub%2Fexample.com%2F%3Arw&relay=${relay}&secret=${secret}`,
      `pubkyring://signin?caps=%2Fpub%2Fexample.com%2F%3Arw&relay=${relay}&secret=${secret}`,
    ]) expect(storeRingRoute(link), link).toMatchObject({ action: "auth", kind: "signin", caps: ["/pub/example.com/:rw"] });
    // No relay or no secret: not an auth request. A grant link of any kind: unknown to it.
    expect(storeRingRoute(`pubkyauth://signin?caps=%2Fpub%2Fx%2F%3Aw&secret=${secret}`)).toEqual({ action: "unknown" });
    expect(storeRingRoute(`pubkyauth://signin?caps=%2Fpub%2Fx%2F%3Aw&relay=${relay}`)).toEqual({ action: "unknown" });
    expect(storeRingRoute(`pubkyauth://signup_grant?hs=x&caps=%2Fpub%2Fx%2F%3Aw&relay=${relay}&secret=${secret}`)).toEqual({ action: "unknown" });
    expect(storeRingRoute(`pubkyauth://signup?hs=abc&relay=${relay}&secret=${secret}`)).toEqual({ action: "signup" });
  });
});

type StoreRingRoute =
  | { action: "auth"; kind: "signin" | "signup"; caps: string[]; relay: string | null; secret: string | null; xSource?: string }
  | { action: "signup" | "direct_signup" | "session" | "unknown" };

/**
 * How the Pubky Ring in the app stores (1.19, built before pubky/pubky-ring#360 taught it `signin_grant`) routes a
 * scanned `pubkyauth:` link, ported from pubky-ring c6e73d0: `src/utils/inputParser.ts` `parseInput` with the native
 * `parseAuthUrl` it calls (@synonymdev/react-native-pubky 0.13.0, pubky-core-ffi 782d6c0 `src/auth.rs`
 * `parse_pubky_auth_url`). `src/utils/inputRouter.ts` answers "Unrecognized format" (`errors.unrecognizedFormat`) for
 * `unknown`. Left out: the migrate, invite-code and recovery-phrase branches, which no auth link can match.
 */
function storeRingRoute(rawInput: string): StoreRingRoute {
  let input = rawInput.trim();
  const rawEncodedQuery = input.includes("?") ? input.slice(input.indexOf("?")) : "";
  // It decodes the whole link up to three times before looking at it.
  for (let i = 0; i < 3; i++) {
    try { const next = decodeURIComponent(input); if (next === input) break; input = next; } catch { break; }
  }
  if (input.startsWith("pubkyring://")) input = input.replace("pubkyring://", "");
  if (input.startsWith("pubkyauth///")) input = input.replace("pubkyauth///", "pubkyauth:///");
  let rest = input.startsWith("pubkyauth://") ? input.replace("pubkyauth://", "") : input;
  for (const route of ["signup", "direct_signup", "session", "signin"])
    if (rest.startsWith(`${route}/?`)) rest = rest.replace(`${route}/?`, `${route}?`);

  const params = (q: string) => new URLSearchParams(q);
  if (rest.startsWith("direct_signup?") && params(rest.slice("direct_signup?".length)).get("hs")) return { action: "direct_signup" };
  if (rest.startsWith("signup?")) {
    const q = params(rest.slice("signup?".length));
    if (q.get("relay") && q.get("secret") && q.get("hs")) return { action: "signup" };
    if (q.get("hs")) return { action: "direct_signup" };
  }
  if (rest.startsWith("session?") && /(?:^|[?&])(?:x-success|callback)=/.test(rawEncodedQuery)) return { action: "session" };
  if (rest.startsWith("signin?")) input = `pubkyauth:///?${rest.slice("signin?".length)}`;

  // parse_pubky_auth_url: scheme pubkyauth, the intent in the host (none means signin), relay and secret required,
  // caps split on "," and each on its first ":". Unknown query keys are ignored.
  let url: URL;
  try { url = new URL(input); } catch { return { action: "unknown" }; }
  if (url.protocol !== "pubkyauth:") return { action: "unknown" };
  const kind = url.hostname === "" || url.hostname === "signin" ? "signin" : url.hostname === "signup" ? "signup" : undefined;
  const relay = url.searchParams.get("relay"), secret = url.searchParams.get("secret");
  if (!kind || relay === null || secret === null) return { action: "unknown" };
  const capsText = url.searchParams.get("capabilities") ?? url.searchParams.get("caps") ?? "";
  const caps: string[] = [];
  for (const capability of capsText ? capsText.split(",") : []) {
    const at = capability.indexOf(":");
    if (at < 0) return { action: "unknown" };
    caps.push(`${capability.slice(0, at)}:${capability.slice(at + 1)}`);
  }
  const xSource = /(?:^|[?&])x-source=([^&]*)/.exec(rawEncodedQuery)?.[1];
  return { action: "auth", kind, caps, relay, secret, ...(xSource === undefined ? {} : { xSource: decodeURIComponent(xSource) }) };
}
