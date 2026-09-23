import type { BrowserContext, Route } from "@playwright/test";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";

/**
 * An OpenID Connect issuer that lives in the test process, for the identity
 * proofs a person makes by signing in with a provider. The web app knows it
 * only when it was built with `VITE_OIDC_TEST_ISSUER` set to its address (the
 * suite's build is; a release build never is), as the provider "Test issuer"
 * with client ID `ghostly-e2e`.
 *
 * Like the Pkarr relay, it answers a context's requests to its address, so
 * nothing listens on a port: `.test` is a name reserved for testing, the only
 * kind of host a test issuer may have (proofs/oidc/providers.ts). It signs
 * real ES256 ID tokens with a key it publishes at `/jwks`, and shows a sign-in
 * page the test clicks through.
 */
export const OIDC_TEST_ISSUER = process.env.E2E_OIDC_ISSUER ?? "https://oidc.ghostly.test";
const CLIENT_ID = "ghostly-e2e";

interface Key { kid: string; privateKey: KeyObject; jwk: Record<string, unknown> }

function newKey(kid: string): Key {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return { kid, privateKey, jwk: { ...publicKey.export({ format: "jwk" }), kid, use: "sig", alg: "ES256" } };
}

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

export class LocalOidcIssuer {
  private keys: Key[] = [newKey("e2e-1")];
  /** Every authorization request the issuer answered, for assertions. */
  readonly requests: URLSearchParams[] = [];
  /** When set, the next token carries this nonce instead of the one asked for. */
  nonceOverride: string | undefined;

  constructor(readonly issuer = OIDC_TEST_ISSUER) {}

  /** An ID token as the provider would sign it. */
  token(claims: Record<string, unknown>): string {
    const key = this.keys[0];
    const now = Math.floor(Date.now() / 1000);
    const body = b64({ iss: this.issuer, aud: CLIENT_ID, iat: now, exp: now + 3600, ...claims });
    const head = b64({ alg: "ES256", typ: "JWT", kid: key.kid });
    const signature = sign("sha256", Buffer.from(`${head}.${body}`), { key: key.privateKey, dsaEncoding: "ieee-p1363" });
    return `${head}.${body}.${signature.toString("base64url")}`;
  }

  /** A new signing key first in the set, the old one still published. */
  rotate(): void {
    this.keys = [newKey(`e2e-${this.keys.length + 1}`), ...this.keys];
  }

  async attach(context: BrowserContext): Promise<void> {
    await context.route(`${this.issuer}/**`, (route) => this.fulfill(route));
  }

  private async fulfill(route: Route): Promise<void> {
    const answer = this.answer(new URL(route.request().url()));
    await route.fulfill({ status: answer.status, headers: answer.headers, body: answer.body });
  }

  private answer(url: URL): { status: number; headers: Record<string, string>; body: string } {
    const json = (value: unknown) => ({ status: 200, headers: { "content-type": "application/json", "access-control-allow-origin": "*" }, body: JSON.stringify(value) });
    const html = (body: string, status = 200) => ({ status, headers: { "content-type": "text/html; charset=utf-8" }, body });
    const params = url.searchParams;
    switch (url.pathname) {
      case "/.well-known/openid-configuration":
        return json({
          issuer: this.issuer, authorization_endpoint: `${this.issuer}/authorize`, jwks_uri: `${this.issuer}/jwks`,
          response_types_supported: ["id_token"], id_token_signing_alg_values_supported: ["ES256"], scopes_supported: ["openid", "email", "profile"],
        });
      case "/jwks":
        return json({ keys: this.keys.map((k) => k.jwk) });
      case "/authorize": {
        this.requests.push(params);
        const redirect = params.get("redirect_uri") ?? "";
        if (params.get("client_id") !== CLIENT_ID || params.get("response_type") !== "id_token" || !params.get("nonce") ||
            !/^http:\/\/(localhost|127\.0\.0\.1):\d+\/oidc-callback\.html$/.test(redirect))
          return html("<p>Invalid request</p>", 400);
        const approve = new URL(`${this.issuer}/approve`);
        for (const name of ["redirect_uri", "nonce", "state", "scope"]) approve.searchParams.set(name, params.get(name) ?? "");
        const scopes = (params.get("scope") ?? "").split(" ");
        return html(`<!doctype html><title>Test issuer</title><h1>Test issuer</h1>
          <p>Ghostly asks for: ${scopes.map((s) => s.replace(/[^a-z]/g, "")).join(", ")}</p>
          <a id="approve" href="${approve.toString().replace(/&/g, "&amp;")}">Continue as alice</a>`);
      }
      case "/approve": {
        const scopes = (params.get("scope") ?? "").split(" ");
        const token = this.token({
          sub: "alice-0001", nonce: this.nonceOverride ?? params.get("nonce"),
          ...(scopes.includes("email") ? { email: "alice@example.test", email_verified: true } : {}),
          ...(scopes.includes("profile") ? { name: "Alice Example" } : {}),
        });
        const target = `${params.get("redirect_uri")}#id_token=${token}&state=${encodeURIComponent(params.get("state") ?? "")}`;
        return { status: 302, headers: { location: target }, body: "" };
      }
      default:
        return { status: 404, headers: {}, body: "" };
    }
  }
}
