import { describe, expect, it } from "vitest";
import { IDENTITY_PROVIDERS } from "../src/proofs/registry";
import { FAKE_IDENTITY_PROVIDERS } from "../src/proofs/testing";
import { bitcoin } from "../src/proofs/providers/bitcoin";
import { oidc } from "../src/proofs/providers/oidc";
// covers: proofs.picker

/**
 * Profile → Identities shows each provider as a card to recognize at a glance (mark, name, category, one
 * short line) and keeps the explanation for the details view. The descriptor is the source of both, so a
 * provider added later follows the same shape.
 */
describe("identity provider cards", () => {
  it.each([...IDENTITY_PROVIDERS, ...FAKE_IDENTITY_PROVIDERS].map(p => [p.id, p] as const))("%s: one short line for the card, a fuller one for the details", (_id, p) => {
    expect(p.summary.trim().length).toBeGreaterThan(0);
    expect(p.summary.length, `"${p.summary}" is longer than one line`).toBeLessThanOrEqual(40);
    expect(p.summary).not.toMatch(/\.$/);
    expect(p.description.length).toBeGreaterThan(p.summary.length);
    if (p.limits) expect(p.limits).toMatch(/not/i);
  });

  it("keeps the caveats a contact must not miss", () => {
    expect(bitcoin.limits).toMatch(/does not prove a balance, a past payment, or that you would pay/);
    expect(oidc.limits).toMatch(/attested by the provider, not by a key you hold/i);
  });
});
