import type { SharedIdentity } from "@ghostly/core";
import type { IdentityProofView, LinkIdentitiesView, ReceivedIdentityView } from "@ghostly/browser/shared/types";

export const DAY = 86400;
export const now = () => Math.floor(Date.now() / 1000);

/** One of this profile's proofs, valid for another month and shared nowhere unless the patch says so. */
export function proofView(patch: Partial<IdentityProofView> = {}): IdentityProofView {
  const subject = patch.subject ?? "example.com";
  return {
    id: "proof-1", provider: "domain", subject, key: "proofkey",
    verified: { subject, source: "DNS TXT record" },
    issuedAt: now() - DAY, expiresAt: now() + 30 * DAY, createdAt: now() - DAY, sharedWith: 0,
    ...patch,
  };
}

/** A contact's proof as this app checked it: verified, valid for another month. */
export function receivedView(patch: Partial<ReceivedIdentityView> = {}): ReceivedIdentityView {
  const subject = patch.subject ?? "example.org";
  return {
    id: "received-1", provider: "domain", subject,
    verified: { subject, source: "DNS TXT record for example.org" },
    status: "verified", verifiedAt: now() - DAY, checkedAt: now() - DAY, expiresAt: now() + 30 * DAY, recheckDue: false,
    ...patch,
  };
}

export function sharedView(patch: Partial<SharedIdentity> = {}): SharedIdentity {
  return { id: "proof-1", provider: "domain", subject: "example.com", status: "accepted", at: now(), ...patch };
}

export function identitiesView(patch: Partial<LinkIdentitiesView> = {}): LinkIdentitiesView {
  return { support: true, shared: [], received: [], ...patch };
}
