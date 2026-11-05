/**
 * Where a proof's name came from (`display.source`), in the fixed words the providers write it in. The app says these
 * in its own language (`displaySourceOf` reads them back, from new proofs and stored ones alike); any other source is
 * shown as written.
 */

/** The user ID is its holder's own words: shown with that caveat, never as a checked name. */
export const OPENPGP_USER_ID_SOURCE = "User ID on the key, written by its holder: not proof that the name or email is theirs";
export const OPENPGP_KEYSERVER_SOURCE = "Email confirmed to keys.openpgp.org by its owner: the keyserver's check, not Ghostly's";

export type OidcEmail = "verified" | "unverified";

/** A sign-in provider's ID token: who signed it, and whether it says the email is checked. */
export function oidcDisplaySource(provider: string, email?: OidcEmail): string {
  return `Signed by ${provider}${email === "verified" ? `; email verified by ${provider}` : email === "unverified" ? `; email not verified by ${provider}` : ""}`;
}

export type DisplaySource =
  | { kind: "openpgp-user-id" }
  | { kind: "openpgp-keyserver" }
  | { kind: "oidc"; provider: string; email?: OidcEmail };

/** Which fixed source a proof of this provider has, or undefined for one shown as written. */
export function displaySourceOf(provider: string, source: string): DisplaySource | undefined {
  if (provider === "openpgp") {
    if (source === OPENPGP_USER_ID_SOURCE) return { kind: "openpgp-user-id" };
    if (source === OPENPGP_KEYSERVER_SOURCE) return { kind: "openpgp-keyserver" };
    return undefined;
  }
  if (provider !== "oidc") return undefined;
  const oidc = /^Signed by (.+?)(?:; email (not )?verified by (.+))?$/.exec(source);
  if (!oidc || (oidc[3] !== undefined && oidc[3] !== oidc[1])) return undefined;
  const [, signer, not, also] = oidc;
  return { kind: "oidc", provider: signer!, ...(also !== undefined ? { email: not ? "unverified" : "verified" } : {}) };
}
