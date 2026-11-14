import { describe, expect, it } from "vitest";
import { OPENPGP_KEYSERVER_SOURCE, OPENPGP_USER_ID_SOURCE, displaySourceOf, oidcDisplaySource } from "../src/proofs/displaySource";

describe("displaySourceOf", () => {
  it("reads back each fixed source the providers write", () => {
    expect(displaySourceOf("openpgp", OPENPGP_USER_ID_SOURCE)).toEqual({ kind: "openpgp-user-id" });
    expect(displaySourceOf("openpgp", OPENPGP_KEYSERVER_SOURCE)).toEqual({ kind: "openpgp-keyserver" });
    expect(displaySourceOf("oidc", oidcDisplaySource("Google"))).toEqual({ kind: "oidc", provider: "Google" });
    expect(displaySourceOf("oidc", oidcDisplaySource("Microsoft", "verified"))).toEqual({ kind: "oidc", provider: "Microsoft", email: "verified" });
    expect(displaySourceOf("oidc", oidcDisplaySource("GitLab", "unverified"))).toEqual({ kind: "oidc", provider: "GitLab", email: "unverified" });
    expect(displaySourceOf("oidc", oidcDisplaySource("Microsoft", undefined, true))).toEqual({ kind: "oidc", provider: "Microsoft", nameUnchecked: true });
    expect(displaySourceOf("oidc", oidcDisplaySource("Google", "verified", true))).toEqual({ kind: "oidc", provider: "Google", email: "verified", nameUnchecked: true });
    expect(displaySourceOf("oidc", oidcDisplaySource("Google", "unverified", true))).toEqual({ kind: "oidc", provider: "Google", email: "unverified", nameUnchecked: true });
  });

  it("says a name the account set for itself was not checked", () => {
    expect(oidcDisplaySource("Microsoft", undefined, true)).toBe("Signed by Microsoft; name set on the account, not checked by Microsoft");
    // Another provider's name in the caveat is not one of these words: shown as written.
    expect(displaySourceOf("oidc", "Signed by Microsoft; name set on the account, not checked by Google")).toBeUndefined();
    expect(displaySourceOf("oidc", "Signed by Google; email verified by Google; name set on the account, not checked by Microsoft")).toBeUndefined();
  });

  it("the words stored proofs already hold", () => {
    expect(oidcDisplaySource("Google", "unverified")).toBe("Signed by Google; email not verified by Google");
    expect(displaySourceOf("oidc", "Signed by Google; email not verified by Google")).toEqual({ kind: "oidc", provider: "Google", email: "unverified" });
    expect(displaySourceOf("nostr", "Nostr signature (NIP-01, BIP-340)")).toEqual({ kind: "nostr-signature" });
  });

  it("nothing for any other source, or another provider's, shown as written", () => {
    for (const source of ["keys.openpgp.org", "Signed by Google; email verified by Microsoft", "signed by Google", "Signed by ", ""]) {
      expect(displaySourceOf("oidc", source)).toBeUndefined();
    }
    expect(displaySourceOf("nostr", "Signed by another Nostr key")).toBeUndefined();
    expect(displaySourceOf("oidc", OPENPGP_USER_ID_SOURCE)).toBeUndefined();
    expect(displaySourceOf("domain", OPENPGP_KEYSERVER_SOURCE)).toBeUndefined();
    expect(displaySourceOf("oidc", "Nostr signature (NIP-01, BIP-340)")).toBeUndefined();
  });
});
