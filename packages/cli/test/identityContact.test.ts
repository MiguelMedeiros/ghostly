import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyIdentityLedger, identityStatement, newIdentityBinding, type IdentityLedger, type ReceivedIdentity, type VerifiedIdentity } from "@ghostly/core";
import type { EngineState, LinkView } from "@ghostly/browser/shared/types";
import { IdentityProofs } from "@ghostly/browser/engine/identities";
import { IDENTITY_PROVIDERS } from "@ghostly/browser/proofs/registry";
import { callApi, type ApiContext } from "../src/api";
// covers: headless.identities

/**
 * `identity contact` printed `recheckDue: true` for a contact's withdrawn or revoked proof, which the app never checks
 * again, and 10 minutes after a GitHub key's check, which the app repeats only after a day. The view here is the app's
 * own (`IdentityProofs.linkView`), as the daemon's state carries it.
 */
type Status = ReceivedIdentity["status"];
function contact(status: Status, checkedAt: number) {
  const { binding } = newIdentityBinding({ provider: "ssh-github", subject: "octocat", validitySeconds: 90 * 86_400 });
  const proof: ReceivedIdentity = { id: identityStatement(binding).id, binding, evidence: { sig: "A".repeat(86) }, verified: { subject: "octocat", source: "A key github.com lists" } as VerifiedIdentity,
    presenter: "them", audience: "me", context: "c".repeat(64), verifiedAt: checkedAt, checkedAt, status };
  const ledger: IdentityLedger = { ...emptyIdentityLedger(), received: [proof] };
  const engine = new IdentityProofs({ ledger: () => ledger, updateLedger: async () => ledger, channel: () => undefined, keys: () => ({ mine: "me", theirs: "them" }),
    linkIds: () => ["chat"], online: () => true, emit: () => {}, publish: async () => {}, resolve: async () => null }, () => IDENTITY_PROVIDERS);
  const link = () => ({ id: "chat", label: "Alice", peerPubKeyZ32: "them", createdAt: 1, lastMessageAt: 0, profile: "paired-chat/1", pairing: { status: "ready" },
    identities: engine.linkView("chat", true) }) as unknown as LinkView;
  const node = { getState: () => ({ links: [link()], groups: [], settings: {}, transport: {}, identityProofs: [] }) as unknown as EngineState };
  const ctx = { runtime: { server: { node }, paths: { name: "default" } }, hub: { emit: () => {}, onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0, replay: () => [] }, mode: "daemon", version: "test" } as unknown as ApiContext;
  return async () => ((await callApi(ctx, "identity.contact", { chat: "chat" })) as { received: { status: string; recheckDue: boolean }[] }).received[0];
}

afterEach(() => { vi.useRealTimers(); });

describe("identity contact: recheckDue", () => {
  it("is true only when the app itself would check again: a GitHub key a day after its check, never a withdrawn or revoked proof", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now(), checkedAt = Math.floor(t0 / 1000);
    const at = (ms: number) => vi.setSystemTime(t0 + ms);
    const verified = contact("verified", checkedAt);
    at(11 * 60_000);
    expect(await verified()).toMatchObject({ status: "verified", recheckDue: false });
    at(86_400_000);
    expect(await verified()).toMatchObject({ status: "verified", recheckDue: true });
    const unconfirmed = contact("unconfirmed", checkedAt);
    expect(await unconfirmed()).toMatchObject({ status: "unconfirmed", recheckDue: true });
    for (const status of ["withdrawn", "revoked"] as const) {
      const proof = contact(status, checkedAt);
      for (const ms of [11 * 60_000, 86_400_000, 40 * 86_400_000]) {
        at(ms);
        expect(await proof(), `${status} after ${ms} ms`).toMatchObject({ status, recheckDue: false });
      }
    }
  });
});
