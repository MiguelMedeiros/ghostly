import {
  DEFAULT_RELAYS, homeserverWebEndpoint, openRelayPayload, pubkyHomeserverOf, PUBKY_PROOF_MAX_BYTES,
  type HomeserverEndpoint,
} from "@ghostly/core";
import type { GrantAuthFlow, Session } from "@synonymdev/pubky";
import type { ApprovalRequest, IdentityFetch } from "./contract";
import { getBrowserHost } from "../host";

/**
 * Pubky, browser side: reading a key's records and files the way a contact's app does (through the proof
 * contract's bounded `ctx.fetch` only), and asking the person to approve ONE Pubky auth request in Pubky Ring or
 * Pubky Passport (https://github.com/pubky/pubky-passport/blob/main/docs/integration.md). See WISP 302.
 */

// -- reading ---------------------------------------------------------------------------------------

/** Pkarr relays the records are read from: Pubky's own, the ones the Pubky SDK uses. */
export const PUBKY_RELAYS: readonly string[] = DEFAULT_RELAYS;
/** A Pkarr relay payload: 64-byte signature, 8-byte timestamp, a DNS packet of at most 1000 bytes. */
const RELAY_PAYLOAD_MAX = 1072;

/**
 * The newest DNS packet the relays hold for `key`, its signature checked against `key`. Every relay is asked; one
 * that is down, answers garbage or holds an older packet does not count. Throws when none has a valid one.
 */
export async function pubkyRecords(key: string, fetch: IdentityFetch, signal?: AbortSignal, relays: readonly string[] = PUBKY_RELAYS): Promise<Uint8Array> {
  const answers = await Promise.all(relays.map(async relay => {
    try {
      const r = await fetch(`${relay.replace(/\/+$/, "")}/${key}`, { maxBytes: RELAY_PAYLOAD_MAX, signal });
      return r.status === 200 ? openRelayPayload(key, r.bytes) : undefined;
    } catch { return undefined; }
  }));
  const newest = answers.filter(a => !!a).sort((a, b) => (b.timestampMicros > a.timestampMicros ? 1 : b.timestampMicros < a.timestampMicros ? -1 : 0))[0];
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
 */
export async function readPubkyFile(key: string, path: `/pub/${string}`, fetch: IdentityFetch, signal?: AbortSignal, relays?: readonly string[]): Promise<{ text: string | undefined; host: string }> {
  const { endpoint } = await pubkyHomeserver(key, fetch, signal, relays);
  const origin = `https://${endpoint.host}${endpoint.port ? `:${endpoint.port}` : ""}`;
  const r = await fetch(`${origin}${path}`, { headers: { "pubky-host": key }, maxBytes: PUBKY_PROOF_MAX_BYTES, signal });
  if (r.status === 404) return { text: undefined, host: endpoint.host };
  if (r.status !== 200) throw new Error(`The homeserver ${endpoint.host} answered ${r.status}`);
  return { text: r.text, host: endpoint.host };
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

/**
 * Starts ONE grant auth flow for `capability`, shows it both ways (a Passport button, a QR code for Ring: the same
 * request), and waits for whichever approves it first, then runs `work` with the session. The session lives only
 * in this renderer's memory while `work` runs, and is signed out afterwards; nothing about it is stored. An
 * approval that arrives after a cancel is signed out at once.
 */
export async function withPubkyApproval<T>(options: PubkyApprovalOptions, work: (session: PubkyApprovedSession) => Promise<T>): Promise<T> {
  const { signal } = options;
  signal.throwIfAborted();
  const { GrantAuthFlow, AuthFlowKind } = await import("@synonymdev/pubky");
  signal.throwIfAborted();
  let flow: GrantAuthFlow;
  try {
    // The flow's proof-of-possession key stays in this flow's memory (not the SDK's delegated IndexedDB key).
    flow = GrantAuthFlow.start(options.capability, AuthFlowKind.signin(), { clientId: PUBKY_CLIENT_ID, relay: options.relay ?? null, xCallback: { xSource: "Ghostly" } });
  } catch (e) { throw failure("Could not start a Pubky request", e); }

  const opened: { window?: Window | null } = {};
  let inFlight: Promise<Session | undefined> | undefined;
  const url = flow.authorizationUrl;
  options.onApproval({
    open: {
      label: "Approve in your browser (Pubky Passport)",
      description: "Opens Pubky Passport. No Passport identity yet? It offers “Continue with Google” and makes one.",
      run: () => { opened.window = (options.openPassport ?? openPassportWindow)(passportUrl(url)) ?? null; },
    },
    qr: { value: url, label: "Or scan with Pubky Ring" },
    notes: [
      "An identity Passport makes with Google is recovered with Google plus Passport: both are needed, neither alone can.",
      "The code is your request: scan it yourself, and do not share it.",
    ],
  });

  // A poll can hold the relay's long poll open; a cancel does not wait for it (what lands later is signed out).
  const cancelled = new Promise<never>((_, reject) => {
    const stop = () => reject(signal.reason);
    if (signal.aborted) stop(); else signal.addEventListener("abort", stop, { once: true });
  });
  cancelled.catch(() => {});
  let session: Session | undefined;
  try {
    const deadline = Date.now() + (options.timeoutMs ?? APPROVAL_TIMEOUT);
    while (!session) {
      signal.throwIfAborted();
      if (Date.now() >= deadline) throw new Error("Nobody approved the request in time. Start again for a new one.");
      inFlight = flow.tryPollOnce();
      session = await Promise.race([inFlight, cancelled]).catch(e => { if (signal.aborted) throw signal.reason; throw failure("The Pubky request failed", e); });
      inFlight = undefined;
      if (!session) await Promise.race([new Promise(resolve => setTimeout(resolve, POLL_EVERY)), cancelled]);
    }
  } finally {
    options.onApproval(null);
    try { if (opened.window && !opened.window.closed) opened.window.close(); } catch { /* another origin's window: best effort */ }
    const pending = inFlight;
    // A flow is freed only when no call of it is in flight; a session that lands after the end is signed out.
    void (pending ?? Promise.resolve(undefined)).then(async late => {
      if (late && late !== session) { try { await late.signout(); } catch { /* best effort */ } finally { late.free(); } }
    }, () => {}).finally(() => flow.free());
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

  const approved = session;
  try {
    return await work({
      key,
      put: (path, text) => approved.storage.putText(path, text).catch(e => { throw failure("Could not write to your homeserver", e); }),
      delete: path => approved.storage.delete(path).catch(e => { throw failure("Could not delete from your homeserver", e); }),
    });
  } finally {
    // The grant is only needed for this: end it, and forget the session.
    try { await approved.signout(); } catch { /* the grant expires on its own */ }
    approved.free();
  }
}
