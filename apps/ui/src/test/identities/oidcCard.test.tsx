import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { identityStatement, newIdentityBinding, toBase64Url, utf8Encode, type IdentityStatement } from "@ghostly/core";
import { createOidcIdentityProvider } from "@ghostly/browser/proofs/providers/oidc";
import { JwksCache } from "@ghostly/browser/proofs/oidc/jwks";
import { OIDC_PROVIDERS } from "@ghostly/browser/proofs/oidc/providers";
import { verifyIdentity } from "@ghostly/browser/proofs/verify";
import { IdCardFace } from "../../components/identities/IdCardFace";
import { receivedIdCard } from "../../components/identities/idCard";
import { now, receivedView } from "./views";

// covers: proofs.oidc, proofs.deck

vi.setConfig({ testTimeout: 60_000 });

const google = { ...OIDC_PROVIDERS.google, clientIds: { web: "ghostly-web" } };
/** Google signs with RS256; one key pair for the file (RSA generation is slow). */
let pair: Promise<CryptoKeyPair> | undefined;
const enc = (value: unknown) => toBase64Url(utf8Encode(JSON.stringify(value)));

/** A contact's Google proof as this app checks it: a real ID token, signed by a key Google "publishes". */
async function receivedProof(claims: Record<string, unknown>) {
  const keys = await (pair ??= crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]) as Promise<CryptoKeyPair>);
  const { n, e } = await crypto.subtle.exportKey("jwk", keys.publicKey) as JsonWebKey;
  const jwks = JSON.stringify({ keys: [{ kty: "RSA", kid: "k1", use: "sig", alg: "RS256", n, e }] });
  const issuedAt = now();
  const statement: IdentityStatement = identityStatement(newIdentityBinding({ provider: "oidc", subject: google.issuer, validitySeconds: 7 * 86400, now: issuedAt }).binding);
  const signed = `${enc({ alg: "RS256", typ: "JWT", kid: "k1" })}.${enc({ iss: google.issuer, aud: "ghostly-web", sub: "1234", iat: issuedAt + 5, exp: issuedAt + 3605, nonce: statement.id, ...claims })}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, utf8Encode(signed) as BufferSource);
  const provider = createOidcIdentityProvider({ providers: () => [google], jwks: new JwksCache(), host: () => undefined });
  const verified = await verifyIdentity([provider], statement, { token: `${signed}.${toBase64Url(new Uint8Array(signature))}` }, {
    now: issuedAt, signal: new AbortController().signal,
    fetch: async url => {
      if (url !== google.jwksUri) throw new Error(`Unexpected network access: ${url}`);
      return { status: 200, contentType: "application/json", text: jwks, bytes: utf8Encode(jwks) };
    },
  });
  return receivedIdCard(receivedView({ provider: "oidc", subject: google.issuer, verified }));
}

describe("a contact's account at a provider, on its ID card", () => {
  it("never shows an email the provider did not verify as who the card is", async () => {
    for (const claims of [{ email: "ceo@bank.test", email_verified: false }, { email: "ceo@bank.test" }]) {
      const card = await receivedProof(claims);
      expect(card).toMatchObject({ statusLabel: "Verified", category: "Attested by accounts.google.com" });
      expect(card.name).toBeUndefined();
      const front = render(<IdCardFace card={card} />);
      expect(front.container.textContent).not.toContain("ceo@bank.test");
      front.unmount();
    }
    // The name the provider signed stays, alone.
    expect((await receivedProof({ email: "ceo@bank.test", name: "Bank" })).name).toBe("Bank");
  });

  it("shows a verified email as the account's name", async () => {
    const card = await receivedProof({ email: "alice@example.test", email_verified: true, name: "Alice" });
    expect(card.name).toBe("Alice · alice@example.test");
    const front = render(<IdCardFace card={card} />);
    expect(front.container.textContent).toContain("Alice · alice@example.test");
  });
});
