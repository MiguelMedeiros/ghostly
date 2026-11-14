import "fake-indexeddb/auto";
import { afterEach, expect, it, vi } from "vitest";
import { emptyIdentityLedger, identityStatement, newIdentityBinding, type IdentityLedger, type ReceivedIdentity } from "@ghostly/core";
import { IdentityProofs } from "../src/engine/identities";
import type { LinkIdentitiesView } from "../src/shared/types";
import { fakeKey, fakeKeySubject } from "../src/proofs/testing";
// covers: proofs.recheck

/**
 * A chat's view is built again only when something changes it, and a contact's proof that expires (or whose re-check
 * falls due) changes nothing stored: the chat asks to be built again at that moment, as the pages would otherwise keep
 * showing Verified, and the CLI never say the proof expired, until something else redrew that chat.
 */

afterEach(() => { vi.useRealTimers(); });

async function chat(validitySeconds: number, recheckAfter: number) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const t = Math.floor(Date.now() / 1000);
  const { binding, seed } = newIdentityBinding({ provider: fakeKey.id, subject: fakeKeySubject(), validitySeconds });
  seed.fill(0);
  const received: ReceivedIdentity = { id: identityStatement(binding).id, binding, evidence: null, verified: { subject: binding.subject, source: "test" },
    presenter: "p", audience: "a", context: "c", verifiedAt: t, checkedAt: t, status: "verified" };
  const ledgers = new Map<string, IdentityLedger>([["chat", { ...emptyIdentityLedger(), received: [received] }]]);
  // The engine's push: a chat asked for is built again, the others keep their last view.
  const views = new Map<string, LinkIdentitiesView | undefined>();
  const engine: IdentityProofs = new IdentityProofs({
    ledger: id => ledgers.get(id), updateLedger: async () => emptyIdentityLedger(), channel: () => undefined,
    keys: () => ({ mine: "a", theirs: "p" }), linkIds: () => [...ledgers.keys()], online: () => false, emit: () => {},
    redraw: id => views.set(id, engine.linkView(id, true)),
    publish: async () => {}, resolve: async () => null,
  }, () => [{ ...fakeKey, recheck: { afterSeconds: recheckAfter } }]);
  await engine.load();
  views.set("chat", engine.linkView("chat", true));
  return { engine, view: () => views.get("chat")!.received[0] };
}

it("builds the chat again when a contact's proof expires: it reads expired then, not Verified", async () => {
  const { engine, view } = await chat(3_600, 86_400);
  expect(view().status).toBe("verified");
  await vi.advanceTimersByTimeAsync(3_599_000);
  expect(view().status).toBe("verified");
  await vi.advanceTimersByTimeAsync(1_000);
  expect(view().status).toBe("expired");
  engine.forget("chat");
});

it("builds the chat again when its re-check falls due, then again at the proof's end", async () => {
  const { engine, view } = await chat(7_200, 600);
  expect(view().recheckDue).toBe(false);
  await vi.advanceTimersByTimeAsync(600_000);
  expect(view()).toMatchObject({ status: "verified", recheckDue: true });
  await vi.advanceTimersByTimeAsync(6_600_000);
  expect(view().status).toBe("expired");
  engine.forget("chat");
});

it("waits past the longest a timer can wait for a proof that lasts longer", async () => {
  const { engine, view } = await chat(40 * 86_400, 60 * 86_400);
  await vi.advanceTimersByTimeAsync(40 * 86_400_000 - 1_000);
  expect(view().status).toBe("verified");
  await vi.advanceTimersByTimeAsync(1_000);
  expect(view().status).toBe("expired");
  engine.forget("chat");
});

it("forgets a removed chat's timer", async () => {
  const { engine } = await chat(3_600, 86_400);
  expect(vi.getTimerCount()).toBe(1);
  engine.forget("chat");
  expect(vi.getTimerCount()).toBe(0);
});
