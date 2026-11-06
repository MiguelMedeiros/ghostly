import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { createIdentity, emptyIdentityLedger, identityStatement, type IdentityLedger } from "@ghostly/core";
import { STORES, transact } from "../src/shared/idb";
import { IdentityProofs, type IdentityLinkHost } from "../src/engine/identities";
import { fakeKey, fakeKeySign, fakeKeySubject } from "../src/proofs/testing";
// covers: proofs.revoke, proofs.binding

/**
 * After a restart the proof key's seed is opened (PBKDF2) the first time it is needed, which can be while a contact's
 * challenge is answered. A Remove or Unshare pressed during that opening must hold: no presentation goes out, and the
 * chat's entry is not written back as if it were still shared.
 */

// A cheap reversible seal (identitiesEngine.test.ts), whose opening a test can hold.
const held = vi.hoisted(() => ({ gate: undefined as Promise<void> | undefined, entered: () => {} }));
vi.mock("../src/engine/paymentAdapters/persistence", async importOriginal => {
  const real = await importOriginal<typeof import("../src/engine/paymentAdapters/persistence")>();
  const mix = (bytes: Uint8Array, password: string) => bytes.map((b, i) => b ^ password.charCodeAt(i % password.length));
  return {
    ...real,
    sealSeed: async (seed: string, password: string) => ({ version: 1, salt: [], iv: [], ciphertext: [...mix(new TextEncoder().encode(seed), password)] }),
    unsealSeed: async (sealed: { ciphertext: number[] }, password: string) => {
      if (held.gate) { held.entered(); await held.gate; }
      return new TextDecoder().decode(mix(new Uint8Array(sealed.ciphertext), password));
    },
  };
});

type Me = "a" | "b";
function pair() {
  const keys = { a: createIdentity().pubKeyZ32, b: createIdentity().pubKeyZ32 };
  const ledgers: Record<Me, IdentityLedger> = { a: emptyIdentityLedger(), b: emptyIdentityLedger() };
  const state = { connected: true };
  const frames: string[] = [];
  const engines = {} as Record<Me, IdentityProofs>;
  const host = (me: Me): IdentityLinkHost => {
    const them: Me = me === "a" ? "b" : "a";
    return {
      ledger: linkId => linkId === "chat" ? ledgers[me] : undefined,
      updateLedger: async (_id, change) => (ledgers[me] = change(structuredClone(ledgers[me]))),
      channel: linkId => linkId === "chat" && state.connected ? {
        scope: () => ({ subject: keys[me], audience: keys[them], context: "c".repeat(64), session: "s".repeat(64) }),
        send: frame => {
          frames.push(`${me}->${them} ${(frame as { t: string }).t}`);
          queueMicrotask(() => void engines[them].frame("chat", structuredClone(frame) as Record<string, unknown>));
        },
      } : undefined,
      keys: () => ({ mine: keys[me], theirs: keys[them] }),
      linkIds: () => ["chat"], online: () => true, emit: () => {},
      publish: async () => {}, resolve: async () => null,
    };
  };
  const make = (me: Me) => new IdentityProofs(host(me), () => [fakeKey]);
  engines.a = make("a"); engines.b = make("b");
  return { engines, ledgers, state, frames, make };
}

const settled = () => new Promise(resolve => setTimeout(resolve, 50));

describe("a proof stopped while its challenge is answered", () => {
  it.each([
    ["Remove", 1], ["Remove", 2], ["Remove", 3],
    ["Unshare", 1], ["Unshare", 2], ["Unshare", 3],
  ] as const)("%s pressed while the proof key is opened for the contact's challenge holds (run %i)", async action => {
    const { engines, ledgers, state, frames, make } = pair();
    await transact([STORES.settings], stores => {
      for (const key of ["identityProofs", "identityRevocations", "identityRevocationsCheckedAt", "identityRevocationsRound"]) stores[STORES.settings].delete(key);
    });
    await engines.a.load(); await engines.b.load();
    const { draftId, binding } = engines.a.begin({ provider: "fake-key", subject: fakeKeySubject() });
    const { id } = await engines.a.complete({ draftId, evidence: fakeKeySign(identityStatement(binding)) });
    // Shared while the chat is offline: it waits, queued, for the next connection.
    state.connected = false;
    await engines.a.share({ linkId: "chat", id });
    expect(ledgers.a.shared.find(s => s.id === id)?.status).toBe("queued");

    // A restart: the seed is opened again on first use, and that opening is held.
    engines.a.stop();
    engines.a = make("a");
    await engines.a.load();
    let release!: () => void;
    const entered = new Promise<void>(resolve => { held.entered = resolve; });
    held.gate = new Promise<void>(resolve => { release = resolve; });
    try {
      state.connected = true;
      engines.b.ready("chat");
      engines.a.ready("chat");
      await entered;
      expect(frames).toContain("b->a idp-challenge");

      if (action === "Remove") await engines.a.remove({ id });
      else await engines.a.withdraw({ linkId: "chat", id });
      expect(ledgers.a.shared.find(s => s.id === id), "right after the stop").toBeUndefined();
    } finally {
      held.gate = undefined;
      release();
    }
    await settled();

    expect(frames).not.toContain("a->b idp-present");
    expect(ledgers.b.received.find(r => r.id === id), "the contact holds no copy").toBeUndefined();
    expect(ledgers.a.shared.find(s => s.id === id), "this chat's entry").toBeUndefined();
    expect(engines.a.linkView("chat", true)!.shared.find(s => s.id === id)).toBeUndefined();
    expect(engines.a.views().find(v => v.id === id)?.sharedWith ?? 0, "shared with").toBe(0);
    engines.a.stop(); engines.b.stop();
  });
});
