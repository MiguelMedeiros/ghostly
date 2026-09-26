import {
  homeserverWebEndpoint, IdentityCheckUnavailable, openRelayPayload, pubkyHomeserverOf, PUBKY_PROOF_MAX_BYTES, RELAY_PAYLOAD_MAX_BYTES,
  type HomeserverEndpoint,
} from "@ghostly/core";
import type { AuthFlow, GrantAuthFlow, Session } from "@synonymdev/pubky";
import type { ApprovalRequest, IdentityFetch } from "./contract";
import { assertPublicHost, chosenResolver, type DohResolverId } from "./domain";
import { getBrowserHost, type PubkyCookieSession } from "../host";

/**
 * Pubky, browser side: reading a key's records and files the way a contact's app does (through the proof
 * contract's bounded `ctx.fetch` only), and asking the person to approve one Pubky auth request in Pubky Ring or
 * Pubky Passport (https://github.com/pubky/pubky-passport/blob/main/docs/integration.md). See WISP 302.
 */

// -- reading ---------------------------------------------------------------------------------------

/** Pkarr relays the records are read from: Pubky's own, the ones the Pubky SDK uses. */
export const PUBKY_RELAYS: readonly string[] = ["https://pkarr.pubky.org", "https://pkarr.pubky.app"];

/**
 * The newest DNS packet the relays hold for `key`, its signature checked against `key`. Every relay is asked; one
 * that is down, answers garbage or holds an older packet does not count. Throws when none has a valid one.
 */
export async function pubkyRecords(key: string, fetch: IdentityFetch, signal?: AbortSignal, relays: readonly string[] = PUBKY_RELAYS): Promise<Uint8Array> {
  const failed: unknown[] = [];
  const answers = await Promise.all(relays.map(async relay => {
    let r;
    try { r = await fetch(`${relay.replace(/\/+$/, "")}/${key}`, { maxBytes: RELAY_PAYLOAD_MAX_BYTES, signal }); }
    catch (e) { failed.push(e); return undefined; }
    try { return r.status === 200 ? openRelayPayload(key, r.bytes) : undefined; } catch { return undefined; }
  }));
  const newest = answers.filter(a => !!a).sort((a, b) => (b.seq > a.seq ? 1 : b.seq < a.seq ? -1 : 0))[0];
  // No relay answered at all (offline, a time-out): say that, not that the key has no records.
  if (!newest && failed.length === relays.length && failed[0] instanceof Error) throw failed[0];
  if (!newest) throw new Error("This Pubky key has no records on the Pkarr relays");
  return newest.dnsPacket;
}

/** Where `key`'s homeserver answers browsers: its `_pubky` record, then the homeserver's own HTTPS record. */
export async function pubkyHomeserver(key: string, fetch: IdentityFetch, signal?: AbortSignal, relays?: readonly string[]): Promise<{ homeserver: string; endpoint: HomeserverEndpoint }> {
  const homeserver = pubkyHomeserverOf(await pubkyRecords(key, fetch, signal, relays), key);
  if (!homeserver) throw new Error("This Pubky key names no homeserver");
  const endpoint = homeserverWebEndpoint(await pubkyRecords(homeserver, fetch, signal, relays), homeserver);
  if (!endpoint) throw new Error("The homeserver of this Pubky key publishes no address a browser can reach");
  return { homeserver, endpoint };
}

/**
 * A public file of `key` at `path`, from the homeserver its own records name: bounded, no redirects, the owner in the
 * `pubky-host` header the way the SDK addresses it. `undefined` when the homeserver says it is not there.
 *
 * The key's owner chooses that host, so it is contacted only on port 443 and only once its addresses are all public
 * (the name is resolved first through the chosen DNS-over-HTTPS resolver): a proof never makes a contact's app knock
 * on its own network. Failures on the way there are IdentityCheckUnavailable, which the contact is not told about.
 */
export async function readPubkyFile(key: string, path: `/pub/${string}`, fetch: IdentityFetch, signal?: AbortSignal, relays?: readonly string[], resolver: DohResolverId = chosenResolver().id): Promise<{ text: string | undefined; host: string }> {
  const { endpoint: { host, port } } = await pubkyHomeserver(key, fetch, signal, relays);
  if (port !== undefined) throw new IdentityCheckUnavailable(`The homeserver ${host} answers on port ${port}; only port 443 is contacted`);
  try { await assertPublicHost(host, { fetch, signal, resolver }); }
  catch (e) { throw new IdentityCheckUnavailable(`The homeserver ${host} was not contacted: ${e instanceof Error ? e.message : String(e)}`); }
  let r: Awaited<ReturnType<IdentityFetch>>;
  try { r = await fetch(`https://${host}${path}`, { headers: { "pubky-host": key }, maxBytes: PUBKY_PROOF_MAX_BYTES, signal }); }
  catch (e) {
    // A file over the cap is the owner's doing, and says nothing about this side's network.
    if (/too large/i.test(String(e))) throw e;
    throw new IdentityCheckUnavailable(`The homeserver ${host} could not be reached`);
  }
  if (r.status === 404) return { text: undefined, host };
  if (r.status !== 200) throw new IdentityCheckUnavailable(`The homeserver ${host} answered ${r.status}`);
  return { text: r.text, host };
}

// -- approving -------------------------------------------------------------------------------------

/** The app identifier Pubky Ring and Passport list the grant under. */
export const PUBKY_CLIENT_ID = "ghostly.tools";
export const PASSPORT_ORIGIN = "https://passport.pubky.app";
/** How long one request waits: Pubky's relay keeps a message about five minutes. */
const APPROVAL_TIMEOUT = 5 * 60_000;
const POLL_EVERY = 1_000;

/**
 * Passport's authorize page for a request. The authorization URL carries the relay secret: it goes in the fragment
 * (never sent to a server), encoded exactly once, and is never logged.
 */
export const passportUrl = (authorizationUrl: string) => `${PASSPORT_ORIGIN}/authorize#d=${encodeURIComponent(authorizationUrl)}`;

/** Messages from the SDK may quote the request: nothing that looks like one reaches the UI or a log. */
const redact = (text: string) => text.replace(/pubkyauth:\/\/\S*/gi, "(request)").replace(/#d=\S*/g, "#d=(request)");
const failure = (what: string, e: unknown) => new Error(`${what}${e instanceof Error && e.message ? `: ${redact(e.message)}` : ""}`);

/** An approved Pubky session, only as long as `work` runs: the key, and writes inside the one folder granted. */
export interface PubkyApprovedSession {
  key: string;
  put(path: `/pub/${string}`, text: string): Promise<void>;
  delete(path: `/pub/${string}`): Promise<void>;
}

export interface PubkyApprovalOptions {
  /** The one capability asked for, `/pub/…/:w`. A session granted anything else is refused. */
  capability: `/pub/${string}/:w`;
  signal: AbortSignal;
  onApproval(request: ApprovalRequest | null): void;
  onProgress(message: string): void;
  /** Where Passport opens. The desktop app hands it to the system browser; elsewhere a popup from the click. */
  openPassport?: (url: string) => Window | null | void;
  /** Tests: the SDK's relay, and a shorter wait. */
  relay?: string;
  timeoutMs?: number;
}

/**
 * Opens a Passport window from the click that calls it. It must run synchronously in the click handler, before
 * anything is awaited, or the browser blocks the popup; the desktop app opens the system browser instead.
 */
export function openPassportWindow(url: string): Window | null | void {
  let host: ReturnType<typeof getBrowserHost> | undefined;
  try { host = getBrowserHost(); } catch { host = undefined; }
  if (host?.openPubkyPassport) { void host.openPubkyPassport(url).catch(() => {}); return; }
  // Not `noopener`: the reference lets Ghostly close the window once either signer approved.
  return window.open(url, "pubky-passport", "popup,width=520,height=760");
}

/** What a request of either kind offers while it waits: one poll at a time, freed once no poll is in flight. */
interface PendingRequest { tryPollOnce(): Promise<Session | undefined>; free(): void }

/** A 401 or 403 from the homeserver: the session it was given is not one it accepts. */
const refused = (e: unknown) => {
  const status = (e as { data?: { statusCode?: unknown } } | null)?.data?.statusCode;
  return status === 401 || status === 403;
};

/**
 * Polls every request until one of them is approved and resolves with that session and its request; a cancel, the
 * deadline or a failed poll ends the wait for all of them. Each request is freed once its last poll has settled
 * (never while one is in flight), and a session that lands after the end is signed out at once; `onSettled` runs
 * once all of that is done.
 */
function firstApproval(requests: readonly PendingRequest[], signal: AbortSignal, timeoutMs: number, onSettled: () => void): Promise<{ session: Session; request: PendingRequest }> {
  return new Promise((resolve, reject) => {
    let over = false;
    let polling = requests.length;
    const wakers = new Set<() => void>();
    const end = (settle: () => void) => {
      if (over) return;
      over = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      for (const wake of wakers) wake();
      settle();
    };
    const cancel = () => end(() => reject(signal.reason));
    const timer = setTimeout(() => end(() => reject(new Error("Nobody approved the request in time. Start again for a new one."))), timeoutMs);
    if (signal.aborted) cancel(); else signal.addEventListener("abort", cancel, { once: true });
    const pause = () => new Promise<void>(done => {
      const wake = () => { clearTimeout(t); wakers.delete(wake); done(); };
      const t = setTimeout(wake, POLL_EVERY);
      wakers.add(wake);
    });

    // The end does not wait for a poll in flight (one that got an approval is still redeeming it at the homeserver):
    // its request is freed when it settles, and a session it brings is signed out.
    const poll = async (request: PendingRequest) => {
      try {
        while (!over) {
          let session: Session | undefined;
          try { session = await request.tryPollOnce(); }
          catch (e) { end(() => reject(failure("The Pubky request failed", e))); return; }
          if (session && over) { try { await session.signout(); } catch { /* best effort */ } finally { session.free(); } return; }
          if (session) { const approved = session; end(() => resolve({ session: approved, request })); return; }
          if (!over) await pause();
        }
      } finally {
        request.free();
        if (--polling === 0) onSettled();
      }
    };
    for (const request of requests) void poll(request);
  });
}

/**
 * A request of a cookie session (Ring's approval) to its homeserver: its `/session` or a file of its storage
 * (`/storage/<key>/pub/…`, or `/pub/…` where the homeserver does not address storage by path), sent with the
 * browser's credentials. A grant session's requests carry an `Authorization` header instead, and the relay's
 * and the Pkarr relays' are elsewhere: those stay the page's.
 */
const cookieSessionRequest = (request: Request) =>
  request.credentials === "include" && !request.headers.has("authorization") && /^\/(?:session$|storage\/|pub\/)/.test(new URL(request.url).pathname);

/** Statuses a Response carries no body with. */
const NO_BODY = new Set([204, 205, 304]);

/**
 * Sends the SDK's cookie-session requests through `transport` until the returned function runs. The SDK fetches with
 * the global fetch, so this wraps it; everything else goes on to the page's fetch as it was. The cookie the
 * homeserver sets stays in the transport: the page, and so the SDK, never sees it.
 */
function routeCookieSession(transport: PubkyCookieSession): () => void {
  const pageFetch = globalThis.fetch;
  let closed = false;
  const routed = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    // A Request made from another takes its body over: whatever is made here is what goes on.
    const request = input instanceof Request && init === undefined ? input : new Request(input, init);
    // Once closed, a wrapper something else has wrapped since stays in place: it only passes requests on.
    if (closed || !cookieSessionRequest(request)) return pageFetch(request);
    request.signal.throwIfAborted();
    const body = request.body ? new Uint8Array(await request.arrayBuffer()) : null;
    let answer;
    try { answer = await transport.fetch({ url: request.url, method: request.method, headers: [...request.headers], body }); }
    catch (e) { throw Object.assign(new TypeError(e instanceof Error ? e.message : String(e)), { cause: e }); }
    const response = new Response(NO_BODY.has(answer.status) ? null : answer.body as BodyInit, { status: answer.status, headers: answer.headers });
    // The SDK parses the answer's URL, which a Response made here does not have: it is the request's (no redirects).
    Object.defineProperty(response, "url", { value: request.url });
    return response;
  };
  globalThis.fetch = routed;
  return () => {
    if (closed) return;
    closed = true;
    if (globalThis.fetch === routed) globalThis.fetch = pageFetch;
    transport.close();
  };
}

/** The host's way around a page that drops the homeserver's cookie, if it has one. */
function cookieSessionTransport(): PubkyCookieSession | undefined {
  try { return getBrowserHost().pubkyCookieSession?.(); } catch { return undefined; }
}

/**
 * Starts one request for `capability` in each of the two forms Pubky signers read (a grant request for Passport, a
 * cookie request for Ring's QR code: see below), shows both on one screen, and waits for whichever is approved
 * first, then runs `work` with that session. The session lives only in this renderer's memory while `work` runs,
 * and is signed out afterwards; nothing about it is stored. An approval that arrives after the end is signed out.
 */
export async function withPubkyApproval<T>(options: PubkyApprovalOptions, work: (session: PubkyApprovedSession) => Promise<T>): Promise<T> {
  const { signal } = options;
  signal.throwIfAborted();
  const { AuthFlow, GrantAuthFlow, AuthFlowKind } = await import("@synonymdev/pubky");
  signal.throwIfAborted();
  const relay = options.relay ?? null;
  let grant: GrantAuthFlow, cookie: AuthFlow;
  try {
    // The flow's proof-of-possession key stays in this flow's memory (not the SDK's delegated IndexedDB key).
    grant = GrantAuthFlow.start(options.capability, AuthFlowKind.signin(), { clientId: PUBKY_CLIENT_ID, relay, xCallback: { xSource: "Ghostly" } });
  } catch (e) { throw failure("Could not start a Pubky request", e); }
  try {
    // Same capability and relay, its own secret. The SDK deprecates this flow, but it is the one Ring's store build reads.
    cookie = AuthFlow.start(options.capability, AuthFlowKind.signin(), relay, { xSource: "Ghostly" });
  } catch (e) { grant.free(); throw failure("Could not start a Pubky request", e); }

  const opened: { window?: Window | null } = {};
  options.onApproval({
    open: {
      label: "Approve in your browser (Pubky Passport)",
      description: "Opens Pubky Passport. No Passport identity yet? It offers “Continue with Google” and makes one.",
      run: () => {
        const window = (options.openPassport ?? openPassportWindow)(passportUrl(grant.authorizationUrl));
        opened.window = window ?? null;
        // null: the browser refused the popup (undefined: it opened elsewhere, the system browser).
        if (window === null) options.onProgress("Your browser blocked the Passport window: allow pop-ups for Ghostly and press the button again, or scan the code with Pubky Ring.");
      },
    },
    // Ring gets the cookie request (`pubkyauth://signin?…`), not the grant one: the Ring in the app stores (1.19)
    // predates pubky/pubky-ring#360 and answers "Unrecognized format" to a `signin_grant` link. Move this to
    // grant.authorizationUrl, and drop the cookie flow, once Ring's store build parses `signin_grant`.
    qr: { value: cookie.authorizationUrl, label: "Or scan with Pubky Ring" },
    notes: [
      "An identity Passport makes with Google is recovered with Google plus Passport: both are needed, neither alone can.",
      "The code is your request: scan it yourself, and do not share it.",
    ],
  });

  // Where the page would drop the cookie session's cookie (the desktop app), its requests go through the host, from
  // the first poll (an approval is redeemed inside one) until the last poll has settled and the work is over.
  const transport = cookieSessionTransport();
  const unroute = transport ? routeCookieSession(transport) : () => {};
  let settled!: () => void;
  const polled = new Promise<void>(done => { settled = done; });
  try {
    return await approveAndWork(options, work, { grant, cookie, opened, settled, cookieKept: !!transport });
  } finally {
    void polled.then(unroute);
  }
}

/**
 * The rest of `withPubkyApproval`, once both requests are shown: the wait, the check, and the work. `cookieKept`: the
 * host keeps a cookie session's cookie, so a refusal is not the page's cookie policy.
 */
async function approveAndWork<T>(options: PubkyApprovalOptions, work: (session: PubkyApprovedSession) => Promise<T>, { grant, cookie, opened, settled, cookieKept }: {
  grant: GrantAuthFlow; cookie: AuthFlow; opened: { window?: Window | null }; settled: () => void; cookieKept: boolean;
}): Promise<T> {
  const { signal } = options;
  let session: Session, viaCookie: boolean;
  try {
    const first = await firstApproval([grant, cookie], signal, options.timeoutMs ?? APPROVAL_TIMEOUT, settled);
    session = first.session;
    viaCookie = first.request === cookie;
  } finally {
    options.onApproval(null);
    try { if (opened.window && !opened.window.closed) opened.window.close(); } catch { /* another origin's window: best effort */ }
  }

  options.onProgress("Approved. Checking what Pubky granted…");
  let key: string;
  try {
    const info = session.info;
    const publicKey = info.publicKey;
    try {
      key = publicKey.z32();
      const granted = info.capabilities;
      if (granted.length !== 1 || granted[0] !== options.capability)
        throw new Error("The signer granted different permissions than Ghostly asked for (one proof folder). Nothing was written.");
    } finally { publicKey.free(); info.free(); }
  } catch (e) {
    await session.signout().catch(() => {});
    session.free();
    throw e;
  }

  // A cookie session lives in the homeserver's cookie, a third-party cookie in a page. WebKit drops it (Safari), so the
  // homeserver then refuses the session's writes: say that, not "401". The desktop app keeps it outside its WebView.
  const fail = (what: string) => (e: unknown) => {
    if (viaCookie && !cookieKept && refused(e))
      throw new Error("Pubky Ring approved, but this browser blocked the sign-in cookie of your homeserver, so nothing was changed. Approve with Pubky Passport instead, or use Ghostly in Chrome or the desktop app.");
    throw failure(what, e);
  };
  const approved = session;
  try {
    return await work({
      key,
      put: (path, text) => approved.storage.putText(path, text).catch(fail("Could not write to your homeserver")),
      delete: path => approved.storage.delete(path).catch(fail("Could not delete from your homeserver")),
    });
  } finally {
    // The grant is only needed for this: end it, and forget the session.
    try { await approved.signout(); } catch { /* the grant expires on its own */ }
    approved.free();
  }
}
