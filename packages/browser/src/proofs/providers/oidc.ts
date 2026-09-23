import { IDENTITY_CLOCK_SKEW, type IdentityStatement } from "@ghostly/core";
import type { IdentityProofProvider, IdentityPlatform, RedirectSigner } from "../contract";
import { getBrowserHost, type OidcHost } from "../../host";
import { audiences, isConfigured, oidcProviders, providerForIssuer, type OidcProvider, type OidcReveal } from "../oidc/providers";
import { signInForProof } from "../oidc/flow";
import { MAX_ID_TOKEN_LENGTH, verifyIdToken } from "../oidc/verify";
import { JwksCache, sharedJwksCache } from "../oidc/jwks";

/**
 * Identity proofs through OpenID Connect: the person signs in with a provider (Google, Microsoft,
 * Apple, GitLab, Twitch) whose ID token carries the statement id as `nonce`. The token is the evidence;
 * a contact's app checks the provider's signature against its published keys, the issuer, Ghostly's
 * client ID, the nonce and when the sign-in happened. No Ghostly server is involved, and the proof is
 * only as good as the provider's word: it is attested, not a key the person holds.
 *
 * The statement's subject is the issuer the person picked; the account comes out of `verify`.
 * Configuration and flows per provider: ../oidc/, docs/OIDC-PROVIDERS.md, docs/wisps/3xx-oidc-proofs.md.
 */
export interface OidcEvidence { token: string }

/** How long after the statement the sign-in may have happened: time to pick an account and approve. */
const SIGN_IN_WINDOW = 15 * 60;
const TOKEN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const SUB = /^[\x21-\x7e]{1,255}$/;

function currentHost(): OidcHost | undefined {
  try { return getBrowserHost().oidc; } catch { return undefined; }
}

const hostOf = (issuer: string) => { try { return new URL(issuer).host; } catch { return issuer; } };

export interface OidcIdentityOptions {
  /** The OIDC providers this build knows (tests pass configured ones). */
  providers?: () => OidcProvider[];
  /** The platform's sign-in window. */
  host?: () => OidcHost | undefined;
  /** Provider keys, cached across proofs. */
  jwks?: JwksCache;
  /** The UI-side fetch for GitLab's code exchange. */
  fetch?: typeof fetch;
}

export function createOidcIdentityProvider(options: OidcIdentityOptions = {}): IdentityProofProvider<OidcEvidence> {
  const providers = options.providers ?? (() => oidcProviders());
  const host = options.host ?? currentHost;
  const configured = () => providers().filter(p => audiences(p).length > 0);

  const signer = (id: string, label: string, description: string, reveal: OidcReveal[]): RedirectSigner<OidcEvidence> => ({
    id, kind: "redirect", label, description,
    available: () => { const h = host(); return !!h && providers().some(p => isConfigured(p, h.platform)); },
    start(statement: IdentityStatement, ctx) {
      // Before any await: the popup and the extension's permission prompt need the click's user activation.
      const h = host();
      const opening = h?.open();
      return (async () => {
        if (!h || !opening) throw new Error("Signing in with a provider is not available here.");
        const provider = providerForIssuer(statement.binding.subject, providers());
        if (!provider || !isConfigured(provider, h.platform)) { void opening.then(w => w.close(), () => {}); throw new Error("This provider is not set up in this Ghostly build."); }
        ctx.onProgress(`Sign in with ${provider.name} in the window that opened.`);
        const token = await signInForProof({
          provider, platform: h.platform, nonce: statement.id, window: await opening, signal: ctx.signal, fetch: options.fetch,
          // What the provider cannot put in its token is not asked for.
          reveal: reveal.filter(r => provider.reveal[r]),
        });
        return { token };
      })();
    },
  });

  return {
    id: "oidc",
    label: "Account at a provider",
    category: "provider-attested",
    description: "Sign in with Google, Microsoft, Apple, GitLab or Twitch. The provider vouches that the account is yours: your contact trusts that company, not a key you hold.",
    platforms: ["web", "extension", "desktop"] satisfies IdentityPlatform[],
    subject: {
      label: "Provider",
      help: "Your contact sees your account’s identifier at that provider, plus what you choose to add. GitLab also adds the groups you belong to directly; Apple never gives Ghostly your email.",
      get options() { return configured().map(p => ({ value: p.issuer, label: p.name })); },
      normalize(input: string) {
        const provider = providerForIssuer(input.trim(), configured());
        if (!provider) throw new Error("Choose a provider");
        return provider.issuer;
      },
      short: subject => providerForIssuer(subject, providers())?.name ?? hostOf(subject),
    },
    // Providers rotate their signing keys within weeks (Google about every two); a contact can only
    // check a token while its key is still published, so a proof is short-lived.
    validity: { defaultDays: 7, maxDays: 14 },
    privacy: "Your contact’s app downloads the provider’s public keys (for example from www.googleapis.com), so the provider sees that some app checked a sign-in, not whose. Your contact sees the account identifier and what you chose to share.",
    signers: [
      signer("oidc-account", "Sign in: share the account only", "The token carries the provider’s identifier for your account, nothing else.", []),
      signer("oidc-email", "Sign in: share the account and email", "Adds your email address, where the provider offers it.", ["email"]),
      signer("oidc-profile", "Sign in: share the account, email and name", "Adds your email address and name or username, where the provider offers them.", ["email", "profile"]),
    ],
    parseEvidence(raw) {
      const e = raw as OidcEvidence;
      if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).join(",") !== "token" ||
          typeof e.token !== "string" || e.token.length > MAX_ID_TOKEN_LENGTH || !TOKEN.test(e.token)) throw new Error("Invalid sign-in token");
      return { token: e.token };
    },
    async verify(statement, { token }, ctx) {
      const provider = providerForIssuer(statement.binding.subject, providers());
      if (!provider) throw new Error("This app does not know this provider");
      const id = await verifyIdToken(token, {
        provider, nonce: statement.id, now: ctx.now, jwks: options.jwks ?? sharedJwksCache,
        fetch: async (url, { maxBytes }) => { const r = await ctx.fetch(url, { maxBytes, signal: ctx.signal }); return { status: r.status, text: r.text }; },
        issuedWithin: [statement.binding.issuedAt - IDENTITY_CLOCK_SKEW, statement.binding.issuedAt + SIGN_IN_WINDOW],
      });
      if (!SUB.test(id.subject)) throw new Error("The provider’s account identifier cannot be shown");
      const attester = hostOf(provider.issuer);
      const person = id.name ?? id.username;
      const name = id.email ? (person && `${person} · ${id.email}`.length <= 64 ? `${person} · ${id.email}` : id.email) : person;
      const url = id.username && /^[A-Za-z0-9_.-]{1,64}$/.test(id.username)
        ? provider.id === "gitlab" ? `https://gitlab.com/${id.username}` : provider.id === "twitch" ? `https://www.twitch.tv/${id.username}` : undefined
        : undefined;
      return {
        // Microsoft's issuer names the account's tenant; the others are fixed.
        subject: `${provider.id === "microsoft" ? id.issuer : provider.issuer}#${id.subject}`,
        attester,
        source: `ID token signed by ${attester}`,
        ...(name || url ? { display: {
          ...(name ? { name } : {}), ...(url ? { url } : {}), fetchedAt: id.issuedAt,
          source: `Signed by ${provider.name}${id.email ? id.emailVerified ? `; email verified by ${provider.name}` : `; email not verified by ${provider.name}` : ""}`,
        } } : {}),
      };
    },
  };
}

export const oidc = createOidcIdentityProvider();
