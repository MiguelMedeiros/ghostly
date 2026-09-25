import {
  ATPROTO_PROOF_COLLECTION, AtprotoProofError, atprotoProofRkey, checkAtprotoProofRecord, isAtprotoDid, normalizeAtprotoHandle, shortAtprotoDid,
  verifyAtprotoRecordProof,
} from "@ghostly/core";
import type { IdentityFetch, IdentityProofProvider, InAppSigner, SignerContext } from "../contract";
import { getBrowserHost } from "../../host";
import { boundedIdentityFetch } from "../verify";
import { chosenResolver } from "../domain";
import { lookupAtprotoAccount, publishAtprotoProof, unpublishAtprotoProof, type AtprotoAccess, type AtprotoHost, AtprotoScopeError } from "../atproto/oauth";
import { resolveAtprotoDid, verifiedAtprotoHandle, type AtprotoResolveOptions } from "../atproto/resolve";

/**
 * Identity proofs for an AT Protocol account (Bluesky, or any PDS): the account publishes, in its own
 * repository, one record of the collection `tools.ghostly.proof` carrying the statement, keyed by the
 * proof key. Publishing takes an OAuth approval on the person's server that lets Ghostly create and
 * delete records of that collection only. A contact's app checks it without logging in: the DID
 * document (PLC directory or did:web) names the signing key and the server; the server's
 * `com.atproto.sync.getRecord` answer is a CAR whose commit must be signed by that key and whose tree
 * must lead to the record. The handle is shown only when it resolves back to the DID.
 *
 * The subject is the DID (it outlives handles). Evidence is empty: everything is fetched from the
 * account's own repository, so deleting the record (removing the proof here does) makes re-checks fail.
 * See docs/wisps/3xx-atproto.md and docs/lexicons/tools.ghostly.proof.json.
 */
export type AtprotoEvidence = Record<string, never>;

/** The proof CAR: a commit, the tree path and one small record. Real repositories' paths are a few KiB. */
export const RECORD_PROOF_MAX_BYTES = 256 * 1024;

function currentHost(): AtprotoHost | undefined {
  try { return getBrowserHost().atproto; } catch { return undefined; }
}

const hostOf = (url: string) => new URL(url).host;

export interface AtprotoIdentityOptions {
  /** The platform's sign-in window. */
  host?: () => AtprotoHost | undefined;
  /** The UI side's network for looking the account up before signing in. */
  fetch?: IdentityFetch;
  /** The page's fetch for OAuth and the record (tests pass a fake server). */
  oauthFetch?: typeof fetch;
  /** The PLC directory (tests). */
  plc?: string;
}

export function createAtprotoIdentityProvider(options: AtprotoIdentityOptions = {}): IdentityProofProvider<AtprotoEvidence> {
  const host = options.host ?? currentHost;
  const uiFetch = () => options.fetch ?? boundedIdentityFetch({ online: () => true });
  const resolveOptions = (fetch: IdentityFetch, signal?: AbortSignal): AtprotoResolveOptions =>
    ({ fetch, signal, resolver: chosenResolver().id, ...(options.plc ? { plc: options.plc } : {}) });

  /** Opens the window from the click, looks the account up, then runs OAuth for `work`; always closes the window. */
  function signIn<T>(input: string, access: AtprotoAccess, ctx: SignerContext, work: (flow: Parameters<typeof publishAtprotoProof>[1]) => Promise<T>): Promise<T> {
    // Before any await: the web app's popup needs the click's user activation.
    const h = host();
    const opening = h?.open();
    return (async () => {
      if (!h || !opening) throw new Error("Signing in to an AT Protocol server is not available here.");
      const w = await opening;
      try {
        const resolve = resolveOptions(uiFetch(), ctx.signal);
        ctx.onProgress(`Looking up ${input.trim()}…`);
        const account = await lookupAtprotoAccount(input, { ...resolve, normalize: normalizeAtprotoHandle });
        ctx.signal.throwIfAborted();
        return await work({ platform: h.platform, window: w, account, access, signal: ctx.signal, resolve, onProgress: ctx.onProgress, fetch: options.oauthFetch });
      } finally { w.close(); }
    })();
  }

  const signer = (id: string, access: AtprotoAccess, label: string, description: string): InAppSigner<AtprotoEvidence> => ({
    id, kind: "in-app", label, description,
    action: access === "full" ? "Continue on your server (full access)" : "Continue on your server",
    available: () => !!host(),
    fields: [{
      name: "handle", label: "Handle", kind: "text", placeholder: "alice.bsky.social",
      help: "Your Bluesky handle, your own domain if you use one, or your DID.",
    }],
    run(ctx, work) {
      return signIn(ctx.values.handle ?? "", access, ctx, flow => work({
        subject: async () => flow.account.did,
        sign: async statement => { await publishAtprotoProof(statement, flow); return {}; },
      }));
    },
  });

  // Removing asks for a fresh approval; the server that refused the narrow permission once is asked for full access.
  const fullAccessServers = new Set<string>();

  return {
    id: "atproto",
    label: "Bluesky / AT Protocol",
    category: "self-custodied",
    summary: "Publish a record on your Bluesky server",
    description: "Proves you control a Bluesky (AT Protocol) account: approve on your server, and Ghostly publishes one record in your account's repository. It is public, like the rest of your repository: anyone can see this account made a Ghostly proof, not who you share it with. Contacts check it without logging in.",
    limits: "Signed with your account's key, which your server usually holds. It proves control of the account, not who you are; the handle is shown only while it points back to the account.",
    platforms: ["web", "extension", "desktop"],
    subject: {
      label: "Account (DID)",
      placeholder: "did:plc:…",
      normalize(input: string) {
        const did = input.trim();
        if (!isAtprotoDid(did)) throw new Error("Not an AT Protocol account (did:plc or did:web)");
        return did;
      },
      short: shortAtprotoDid,
    },
    // The account's AT URI, for a public DID document's alsoKnownAs (#247), when the person lists it there.
    publicUri: did => `at://${did}`,
    validity: { defaultDays: 90, maxDays: 365 },
    // The record can be deleted any time: contacts look again after an hour.
    recheck: { afterSeconds: 3600 },
    privacy: "Your contact's app asks the PLC directory (or your did:web host) for your account's document, your server for the record, and its DNS-over-HTTPS resolver or your handle's website for your handle, so they learn this account was checked.",
    signers: [
      signer("atproto-oauth", "proof-records", "Your server (Bluesky or another PDS)",
        "Opens your server's login page. Ghostly asks only to create and delete its own proof records: never to post, read your messages or edit your profile."),
      signer("atproto-oauth-full", "full", "Your server, full access (older servers)",
        "Only if your server says it cannot limit Ghostly's permission: it then asks for access to your whole account. Ghostly still only writes this one record, and gives the access back right away."),
    ],
    parseEvidence(raw) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length) throw new Error("Invalid AT Protocol evidence");
      return {};
    },
    async verify(statement, _evidence, ctx) {
      const did = statement.binding.subject;
      if (!isAtprotoDid(did)) throw new Error("Not an AT Protocol account");
      const resolve = resolveOptions(ctx.fetch, ctx.signal);
      // The server comes from the DID document, never from the proof.
      const doc = await resolveAtprotoDid(did, resolve);
      const rkey = atprotoProofRkey(statement.binding.key);
      const url = `${doc.pds}/xrpc/com.atproto.sync.getRecord?${new URLSearchParams({ did, collection: ATPROTO_PROOF_COLLECTION, rkey })}`;
      let response: Awaited<ReturnType<IdentityFetch>>;
      try { response = await ctx.fetch(url, { headers: { accept: "application/vnd.ipld.car" }, maxBytes: RECORD_PROOF_MAX_BYTES, signal: ctx.signal, redirect: "error" }); }
      // eslint-disable-next-line preserve-caught-error -- A message people can act on; the library's error stays out of the UI (ES2020 has no Error.cause).
      catch (e) { throw new Error(/too large/i.test(String(e)) ? "The account's server sent a proof that is too large" : `The account's server (${hostOf(doc.pds)}) could not be reached`); }
      if (response.status !== 200) {
        let code = "";
        try { code = String((JSON.parse(response.text) as { error?: unknown }).error ?? ""); } catch { /* not JSON */ }
        if (code === "RecordNotFound") throw new Error("The record is no longer in the account's repository");
        if (/^Repo(NotFound|Deactivated|Takendown|Suspended)$/.test(code)) throw new Error("The account is no longer on its server");
        throw new Error(`The account's server (${hostOf(doc.pds)}) did not send the record`);
      }
      let proof: ReturnType<typeof verifyAtprotoRecordProof>;
      try { proof = verifyAtprotoRecordProof(response.bytes, { did, key: doc.key, collection: ATPROTO_PROOF_COLLECTION, rkey }); }
      // eslint-disable-next-line preserve-caught-error -- A message people can act on; the library's error stays out of the UI (ES2020 has no Error.cause).
      catch (e) { throw new Error(e instanceof AtprotoProofError ? `The account's repository does not prove the record: ${e.message}` : "The account's repository could not be read"); }
      if (!proof.record) throw new Error("The record is no longer in the account's repository");
      checkAtprotoProofRecord(proof.record.value, statement);
      const handle = await verifiedAtprotoHandle(doc, resolve);
      return {
        subject: did,
        source: `Record signed with the account's key, from ${hostOf(doc.pds)}`,
        display: {
          ...(handle ? { name: `@${handle}` } : {}),
          url: `https://bsky.app/profile/${did}`,
          source: handle ? "Handle checked both ways: it points to this account" : "The account's handle does not point back to it, so it is not shown",
          fetchedAt: ctx.now,
        },
      };
    },
    unpublish: {
      description: "Also deletes the record on your server: your server asks you to approve.",
      run(proof, ctx) {
        return signIn(proof.subject, "proof-records", ctx, async flow => {
          const access: AtprotoAccess = fullAccessServers.has(flow.account.pds) ? "full" : "proof-records";
          try { await unpublishAtprotoProof(proof.key, { ...flow, access }); }
          catch (e) {
            if (e instanceof AtprotoScopeError && access !== "full") {
              fullAccessServers.add(flow.account.pds);
              // eslint-disable-next-line preserve-caught-error -- A message people can act on; the library's error stays out of the UI (ES2020 has no Error.cause).
              throw new Error("Your server only offers full access to your account. Try again to approve that; Ghostly only deletes this one record.");
            }
            throw e;
          }
        });
      },
    },
  };
}

export const atproto = createAtprotoIdentityProvider();
