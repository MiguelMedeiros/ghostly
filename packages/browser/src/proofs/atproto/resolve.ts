import { atprotoDidMethod, isAtprotoDid, parseAtprotoDidDocument, txtValue, type AtprotoDidDocument } from "@ghostly/core";
import type { IdentityFetch } from "../contract";
import { assertPublicHost, dohQuery, type DohResolverId } from "../domain";

/**
 * AT Protocol identity resolution, the network half: a DID to its document (the PLC directory for
 * did:plc, the host's `/.well-known/did.json` for did:web), and a handle to a DID (DNS TXT
 * `_atproto.<handle>` through the person's DNS-over-HTTPS resolver, then
 * `https://<handle>/.well-known/atproto-did`). Every request goes through the contract's bounded
 * fetch: HTTPS only, no redirects, a size cap, a time-out. URLs are built here from the DID or the
 * handle, never taken from a proof.
 */

export const PLC_DIRECTORY = "https://plc.directory";
const TEST_HOST = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.test$/;
/** DID documents are small; a large answer is not one. */
export const DID_DOCUMENT_MAX_BYTES = 32 * 1024;
const HANDLE_DID_MAX_BYTES = 2048;

/**
 * The PLC directory. A build made for the e2e suite with VITE_ATPROTO_TEST_PLC may point it at a
 * `.test` host (a name reserved for testing); a release build always uses plc.directory.
 */
export function plcDirectory(): string {
  try {
    const value = import.meta.env?.VITE_ATPROTO_TEST_PLC as string | undefined;
    return value && TEST_HOST.test(value) ? value : PLC_DIRECTORY;
  } catch { return PLC_DIRECTORY; }
}

export interface AtprotoResolveOptions {
  fetch: IdentityFetch;
  signal?: AbortSignal;
  /** The DoH resolver for handles (the person's choice, as for domains). */
  resolver?: DohResolverId;
  /** The PLC directory; plcDirectory() by default. */
  plc?: string;
}

/** Where a DID's document lives. */
export function didDocumentUrl(did: string, plc = plcDirectory()): string {
  const method = atprotoDidMethod(did);
  if (method === "plc") return `${plc}/${did}`;
  if (method === "web") return `https://${did.slice("did:web:".length)}/.well-known/did.json`;
  throw new Error("Not an AT Protocol DID");
}

/**
 * Refuses a host the account chose (a did:web host, the PDS its document names) that points to a private
 * network address: a contact's app never knocks on its own local network for someone else's proof.
 */
export async function assertPublicServer(host: string, options: AtprotoResolveOptions): Promise<void> {
  try { await assertPublicHost(host, { fetch: options.fetch, signal: options.signal, resolver: options.resolver }); }
  catch (e) { throw new Error(`The account's server ${host} was not contacted: ${e instanceof Error ? e.message : String(e)}`); } // eslint-disable-line preserve-caught-error -- The domain check's message says why; ES2020 has no Error.cause.
}

/** A DID's document, checked (parseAtprotoDidDocument). Throws a message people can read. */
export async function resolveAtprotoDid(did: string, options: AtprotoResolveOptions): Promise<AtprotoDidDocument> {
  const url = didDocumentUrl(did, options.plc);
  if (atprotoDidMethod(did) === "web") await assertPublicServer(did.slice("did:web:".length), options);
  let response: Awaited<ReturnType<IdentityFetch>>;
  try {
    response = await options.fetch(url, { headers: { accept: "application/did+ld+json, application/json" }, maxBytes: DID_DOCUMENT_MAX_BYTES, signal: options.signal, redirect: "error" });
  } catch (e) {
    // eslint-disable-next-line preserve-caught-error -- A message people can act on; the library's error stays out of the UI (ES2020 has no Error.cause).
    throw new Error(/too large/i.test(String(e)) ? "The account's DID document is too large" : "The account's DID could not be resolved");
  }
  if (response.status === 404 || response.status === 410) throw new Error("The account's DID is not registered, or was deactivated");
  if (response.status !== 200) throw new Error("The account's DID could not be resolved");
  let doc: unknown;
  try { doc = JSON.parse(response.text); } catch { throw new Error("The account's DID document is malformed"); }
  return parseAtprotoDidDocument(doc, did);
}

/**
 * The DID a handle points to, or null when it points nowhere (or to two different DIDs). DNS first,
 * then HTTPS, as the handle spec says. The HTTPS lookup first checks the handle's addresses are public,
 * so a handle cannot make a contact's app knock on its local network.
 */
export async function resolveAtprotoHandle(handle: string, options: AtprotoResolveOptions): Promise<string | null> {
  return (await lookupAtprotoHandle(handle, options)).did;
}

/**
 * resolveAtprotoHandle, and whether the answer is one: `checked` is false when a lookup failed on the way (the
 * resolver or the handle's website could not be reached) so the handle may point somewhere after all. A cancel
 * throws.
 */
async function lookupAtprotoHandle(handle: string, options: AtprotoResolveOptions): Promise<{ did: string | null; checked: boolean }> {
  options.signal?.throwIfAborted();
  const lookup = { fetch: options.fetch, signal: options.signal, resolver: options.resolver };
  let dnsAnswered = false;
  try {
    const answer = await dohQuery(`_atproto.${handle}`, "TXT", lookup);
    dnsAnswered = true;
    const dids = new Set<string>();
    for (const a of answer.answers) {
      if (a.type !== 16) continue;
      let text: string;
      try { text = txtValue(a.data); } catch { continue; }
      if (text.startsWith("did=")) dids.add(text.slice(4));
    }
    if (dids.size > 1) return { did: null, checked: true };
    const [did] = dids;
    if (did) return { did: isAtprotoDid(did) ? did : null, checked: true };
  } catch { options.signal?.throwIfAborted(); /* The resolver failed: try HTTPS. */ }
  // A handle with no public address points nowhere, if the resolver answered (a name it could not resolve may).
  try { await assertPublicHost(handle, lookup); }
  catch { options.signal?.throwIfAborted(); return { did: null, checked: dnsAnswered }; }
  let response: Awaited<ReturnType<IdentityFetch>>;
  try { response = await options.fetch(`https://${handle}/.well-known/atproto-did`, { headers: { accept: "text/plain" }, maxBytes: HANDLE_DID_MAX_BYTES, signal: options.signal, redirect: "error" }); }
  catch { options.signal?.throwIfAborted(); return { did: null, checked: false }; }
  const did = response.status === 200 ? response.text.trim() : "";
  // A DNS record the resolver could not read may still name the DID.
  return isAtprotoDid(did) ? { did, checked: true } : { did: null, checked: dnsAnswered };
}

/** Why a DID's handle is not shown: its document names none, the handle points elsewhere (or nowhere), or the lookup failed. */
export type AtprotoHandleCheck = { handle: string; missing?: undefined } | { handle?: undefined; missing: "none" | "elsewhere" | "unchecked" };

/**
 * The handle to show for a DID: the one its document claims, and only if that handle resolves back to
 * the same DID. Otherwise the reason: the card shows the DID. Throws only when cancelled.
 */
export async function verifiedAtprotoHandle(doc: AtprotoDidDocument, options: AtprotoResolveOptions): Promise<AtprotoHandleCheck> {
  if (!doc.handle) return { missing: "none" };
  const found = await lookupAtprotoHandle(doc.handle, options);
  if (found.did === doc.did) return { handle: doc.handle };
  return { missing: found.did || found.checked ? "elsewhere" : "unchecked" };
}
