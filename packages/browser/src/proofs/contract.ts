import type { IdentityDisplay, IdentityStatement, VerifiedIdentity } from "@ghostly/core";

/**
 * The identity-proof provider contract. A provider is one way to prove control of an external
 * identity (a Nostr key, a domain, a Bitcoin address, an SSH or PGP key, an OpenID Connect account):
 * how the person produces evidence over the shared statement (`signers`), and how any Ghostly app
 * checks it (`verify`). Everything else — the statement bytes, the proof key, sharing per contact,
 * replay protection, storage, expiry, the UI — is shared. See PROOFS.md.
 */

/**
 * Who vouches for the identity. The UI shows the difference:
 *  - self-custodied: the person holds the key (Nostr, SSH, PGP, Bitcoin, a domain they control);
 *    only they can have produced the evidence.
 *  - provider-attested: a company signs that the person logged in to an account (OpenID Connect);
 *    the evidence is only as trustworthy as that company.
 */
export type IdentityCategory = "self-custodied" | "provider-attested";
/** Where Ghostly runs: the web app, the browser extension (engine in an offscreen document), the Tauri app. */
export type IdentityPlatform = "web" | "extension" | "desktop";
export const IDENTITY_PLATFORMS: readonly IdentityPlatform[] = ["web", "extension", "desktop"];

/**
 * A bounded HTTPS GET through the engine: time-out, size cap (`maxBytes`, default 64 KiB), no credentials,
 * no referrer, refused offline. `redirect` defaults to "error": a record that redirects does not count
 * unless the provider says so. `text` is the body as UTF-8; `bytes` is the same body raw (binary
 * answers such as DNS-over-HTTPS `application/dns-message`).
 */
export interface IdentityFetchOptions { headers?: Record<string, string>; maxBytes?: number; signal?: AbortSignal; redirect?: "follow" | "error" }
export interface IdentityFetchResponse { status: number; contentType: string; text: string; bytes: Uint8Array }
export type IdentityFetch = (url: string, options?: IdentityFetchOptions) => Promise<IdentityFetchResponse>;

export interface VerifyContext {
  /** Seconds. Use this, never `Date.now()`, so tests and re-checks agree on time. */
  now: number;
  signal: AbortSignal;
  /** The only way `verify` may reach the network. Never call the global `fetch`. */
  fetch: IdentityFetch;
}

export interface SubjectSpec {
  /** "Public key", "Domain", "Bitcoin address", "Account". */
  label: string;
  placeholder?: string;
  help?: string;
  /** Choices instead of a text field (an OpenID Connect provider's issuer). */
  options?: readonly { value: string; label: string }[];
  /** The canonical subject for what the person typed (or a signer returned). Throw a message they can act on. */
  normalize(input: string): string;
  /** Short form for badges and lists ("npub1x…4f2"). Defaults to the subject. */
  short?(subject: string): string;
  /**
   * What the (normalized) subject turns out to be, shown under the field before anything is signed: a DID's
   * method, its keys and its domain. Runs in the UI on the person's input; may reach the network (the
   * person's own identity). Throw a message they can act on.
   */
  preview?(subject: string, options: { signal: AbortSignal }): Promise<SubjectPreview>;
}

export interface SubjectPreview {
  /** Short facts, in order: "Method" → "did:web", "Keys" → "#key-1 (Ed25519)". */
  facts: readonly { label: string; value: string }[];
  /** The ids of the signers that apply to this subject; every signer when omitted. */
  signers?: readonly string[];
}

/** A field an in-app signer needs (a NIP-46 connection link). `secret` values are never stored or logged. */
export interface SignerField {
  name: string;
  label: string;
  kind: "text" | "secret";
  placeholder?: string;
  help?: string;
  optional?: boolean;
}

export interface SignerContext {
  values: Record<string, string>;
  signal: AbortSignal;
  /** The signer asks the person to approve on a page (NIP-46 auth_url): the UI shows it as a link, never opens it itself. */
  onAuthUrl(url: string): void;
  onProgress(message: string): void;
}

export interface SignerSession<E> {
  /** The identity the signer controls, canonical (as `subject.normalize` returns it). */
  subject(): Promise<string>;
  sign(statement: IdentityStatement): Promise<E>;
}

export interface InstructionStep {
  text: string;
  /** Shown in a copyable block (a command, a DNS record). */
  copy?: string;
}
export interface SignerInstructions {
  steps: readonly InstructionStep[];
  /** external-tool: the field the output is pasted into. */
  paste?: { label: string; placeholder?: string; multiline?: boolean };
}

interface SignerBase {
  /** Unique within the provider: "nip07", "nip46", "ssh-keygen". */
  id: string;
  label: string;
  description?: string;
  /** Defaults to the provider's. */
  platforms?: readonly IdentityPlatform[];
  /** False hides it (no NIP-07 extension in this window). Runs in the UI. */
  available?(): boolean;
}

/** Signs inside Ghostly through something the person already uses (NIP-07, NIP-46, a wallet API). */
export interface InAppSigner<E> extends SignerBase {
  kind: "in-app";
  fields?: readonly SignerField[];
  /** Opens the signer, runs `work`, and always cleans up (closes connections, drops keys) before resolving. */
  run<T>(ctx: SignerContext, work: (session: SignerSession<E>) => Promise<T>): Promise<T>;
}

/** The person runs a tool (ssh-keygen, gpg, a Bitcoin wallet) on the statement and pastes the output back. */
export interface ExternalToolSigner<E> extends SignerBase {
  kind: "external-tool";
  instructions(statement: IdentityStatement): SignerInstructions;
  /** What was pasted, as evidence. Throw a message the person can act on ("That is not an SSH signature"). */
  parse(pasted: string, statement: IdentityStatement): E | Promise<E>;
}

/** A popup to the provider's login page (OpenID Connect); the subject comes out of `verify`. */
export interface RedirectSigner<E> extends SignerBase {
  kind: "redirect";
  start(statement: IdentityStatement, ctx: SignerContext): Promise<E>;
}

/** The person publishes something the verifier fetches (a DNS TXT record, a /.well-known file). */
export interface PublishSigner<E> extends SignerBase {
  kind: "publish";
  instructions(statement: IdentityStatement): SignerInstructions;
  /** Usually small or empty: the verifier looks the record up itself. */
  evidence(statement: IdentityStatement): E | Promise<E>;
}

export type IdentitySigner<E> = InAppSigner<E> | ExternalToolSigner<E> | RedirectSigner<E> | PublishSigner<E>;

/**
 * A provider module's export. Registering it is adding the module under `proofs/providers/` and ONE
 * line in `proofs/registry.ts`.
 */
export interface IdentityProofProvider<E = unknown> {
  /** Stable: it is in the statement, on the wire and in storage. `^[a-z][a-z0-9-]{0,31}$`. */
  id: string;
  label: string;
  category: IdentityCategory;
  /**
   * One short line for the picker card, how you make it: "Sign once with your Nostr signer". About 40
   * characters at most; the card shows nothing else beside the name and the category.
   */
  summary: string;
  /** The details view (opened from the card, shown again above the form): what is proven and how, a sentence or two. */
  description: string;
  /**
   * What the proof does NOT show, when a contact could easily assume more ("Does not prove a balance, a past
   * payment, or that you would pay."). Shown with the description, never hidden behind a hover.
   */
  limits?: string;
  platforms: readonly IdentityPlatform[];
  subject: SubjectSpec;
  /** How long one proof may last. The person picks up to `maxDays` (never above 400). */
  validity: { defaultDays: number; maxDays: number };
  /**
   * When a verifier's check can go stale (the DNS record may be removed later): the contact's app offers
   * "Check again" after this many seconds and shows the last check time. Omit when the evidence is a
   * signature that stays valid until expiry.
   */
  recheck?: { afterSeconds: number };
  /** One sentence for people: what `verify` contacts and who learns what. "Nothing: checked on this device." */
  privacy: string;
  /** Mark providers whose flows are not proven against real-world tools yet. */
  experimental?: boolean;
  /** Listed under "Advanced" in the picker, for people who know what it is (DIDs), so it does not crowd newcomers. */
  advanced?: boolean;
  signers: readonly IdentitySigner<E>[];
  /**
   * Untrusted evidence off the wire → typed evidence. Strict: exact shape, bounded sizes, no extra keys.
   * The serialized evidence is already capped at 16 KiB before this runs.
   */
  parseEvidence(raw: unknown): E;
  /**
   * Checks `evidence` against exactly `statement.bytes` / `statement.text` and returns what it proves.
   * Throws when it does not. Must:
   *  - self-custodied: return `subject === statement.binding.subject`;
   *  - provider-attested: return the attested subject and set `attester`;
   *  - reach the network only through `ctx.fetch`, and use `ctx.now` for time.
   */
  verify(statement: IdentityStatement, evidence: E, ctx: VerifyContext): Promise<VerifiedIdentity>;
  /**
   * Optional public name/picture for a verified subject (Nostr kind-0). Called ONLY when the person asks,
   * never automatically. Sanitize like avatars: plain-text name, bounded raster re-encoded to a data URL.
   */
  lookupDisplay?(subject: string, options: { signal: AbortSignal }): Promise<IdentityDisplay | undefined>;
  /** The button that runs `lookupDisplay`. Default: "Show public profile". */
  lookupLabel?: string;
  /**
   * The verified subject as a URI a public DID document may list in `alsoKnownAs` (the profile's
   * did:dht, and only for identities the person chooses to list there). Omit when the identity has no
   * URI of its own. No comma: did:dht separates the list with commas.
   */
  publicUri?(subject: string): string | undefined;
}
