import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ENDPOINT, engineText, type GhostLink } from "@ghostly/core";
import { FedimintWallet, fedimintTiming } from "../src/engine/paymentAdapters/fedimintWallet";
import { fedimintSdkOn, type FedimintClient } from "../src/engine/paymentAdapters/fedimintSdk";
import { PaymentDesk } from "../src/engine/payments";
import type { CashuWallet } from "../src/engine/wallet";
import { STORES, openDb, transact } from "../src/shared/idb";
import { FakeFedimintSdk, type FakeFederation } from "./helpers/fakeFedimint";
// covers: wallet.fedimint.notes, payments.fedimint.chat

// The web SDK's wallet, as far as RealClient's redeem reads it: a reissue's subscription gives `states`, then `error`
// (an error of the client or of the subscription, which says nothing of the notes).
const reissue = vi.hoisted(() => ({ states: [] as unknown[], error: undefined as string | undefined, asked: 0 }));
vi.mock("@fedimint/core", () => {
  const wallet = {
    open: async () => true,
    federation: { getFederationId: async () => "f".repeat(64) },
    mint: {
      reissueExternalNotes: async () => { reissue.asked++; return "op-1"; },
      subscribeReissueExternalNotes: (_op: string, onState: (s: unknown) => void, onError: (e: string) => void) => {
        const states = [...reissue.states], error = reissue.error;
        const timer = setTimeout(() => { for (const s of states) onState(s); if (error !== undefined) onError(error); }, 0);
        return () => clearTimeout(timer);
      },
    },
    cleanup: async () => {},
  };
  return { WalletDirector: class { async initialize() {} async hasMnemonicSet() { return true; } async setMnemonic() {} async createWallet() { return wallet; } } };
});

fedimintTiming.pollMs = 20;
let fake: FakeFedimintSdk;
let federation: FakeFederation;
let real: FedimintClient;

beforeEach(async () => {
  reissue.states = []; reissue.error = undefined; reissue.asked = 0;
  fake = new FakeFedimintSdk();
  federation = fake.federation({ name: "Regtest federation" });
  real = await (await fedimintSdkOn({ transport: async () => ({ terminate() {} }), exists: async () => true, remove: async () => {} })).open({ database: "ghostly-fedimint-real.db", mnemonic: "a b c" });
  await openDb();
  await transact([STORES.settings, STORES.intents, STORES.payments], (s) => { s[STORES.settings].clear(); s[STORES.intents].clear(); s[STORES.payments].clear(); });
});

/** A joined wallet holding notes of 1,000 sats it handed out, whose redeems go through RealClient. */
async function walletWithNotes() {
  const w = new FedimintWallet("testnet", { changed: vi.fn(), received: vi.fn() }, fake.sdk());
  await w.start();
  await w.join(federation.invite);
  const { invoice } = await w.createInvoice(federation.id, 3_000);
  federation.payInvoice(invoice);
  const { notes } = await w.spendNotes(federation.id, 1_000);
  const client = fake.client(federation);
  client.redeem = real.redeem.bind(real);
  client.redeemState = real.redeemState.bind(real);
  return { w, notes };
}

function chat(fedimint: FedimintWallet) {
  const sent: { ok: unknown; error?: unknown }[] = [];
  const link = { supportsFedimintPayments: true, supportsPayments: true, isDataLinkOpen: true, allowsPayment: () => true, paymentEnabled: () => true,
    sendPaymentResult: vi.fn((frame: { ok: unknown; error?: unknown }) => { sent.push(frame); }) };
  const host = { getLink: () => link as unknown as GhostLink, storeMessage: vi.fn(async () => {}), onChange: vi.fn(), onReviewedPaymentResult: vi.fn(async () => {}), onReviewedPaymentRefused: vi.fn(async () => {}) };
  const desk = new PaymentDesk({} as CashuWallet, host, undefined, undefined, undefined, undefined, undefined, fedimint);
  const lines = () => (host.storeMessage.mock.calls as unknown as [{ text: string }][]).map(([m]) => m.text);
  return { desk, sent, lines };
}

describe("a Fedimint redeem the client could not answer for", () => {
  it("is not a failed redeem: only the reissue's own Failed is", async () => {
    reissue.error = "The Fedimint client stopped: worker gone";
    await expect(real.redeemState("op-1", 1_000)).rejects.toThrow("worker gone");
    reissue.states = ["Created", "Issuing"];
    await expect(real.redeemState("op-1", 1_000), "an error after it started issuing").rejects.toThrow("worker gone");
    reissue.states = [{ Failed: "spent" }];
    await expect(real.redeemState("op-1", 1_000)).resolves.toBe("failed");
    reissue.error = undefined;
    await expect(real.redeemState("op-1", 1_000)).resolves.toBe("failed");
    reissue.states = ["Created", "Issuing", "Done"];
    await expect(real.redeemState("op-1", 1_000)).resolves.toBe("done");
  });

  it("in a chat: the notes are kept, the contact is not told they failed, and they are redeemed later", async () => {
    const { w, notes } = await walletWithNotes();
    const { desk, sent, lines } = chat(w);
    const pay = () => desk.onPayment("l", { id: "p1", timestamp: 1, amount: { value: "1000", asset: "sat" }, endpoint: [ENDPOINT.fedimint, notes] });
    reissue.error = "The Fedimint client stopped: worker gone";
    await pay();
    expect(desk.payment("p1")).toMatchObject({ state: "pending", token: notes, fedimintOp: "op-1", error: expect.stringContaining("worker gone") });
    expect(sent, "no refusal to the contact").toEqual([]);
    expect(lines()).toEqual([]);

    // Retransmitted while the client still errs: asked again, never redeemed twice, nothing said.
    await pay();
    expect(desk.payment("p1")).toMatchObject({ state: "pending", token: notes });
    expect(sent).toEqual([]);

    // At the next start the client answers: the payment settles.
    reissue.error = undefined; reissue.states = ["Created", "Issuing", "Done"];
    await desk.resumeFedimint();
    expect(desk.payment("p1")).toMatchObject({ state: "settled", token: undefined, error: undefined });
    expect(sent).toEqual([expect.objectContaining({ ok: true, credited: "1000" })]);
    expect(lines()).toEqual(["⚡ 1,000 test sats on Fedimint"]);
    expect(reissue.asked, "one redeem").toBe(1);
  });

  it("in a chat, a confirmed Failed still refuses the notes", async () => {
    const { w, notes } = await walletWithNotes();
    const { desk, sent, lines } = chat(w);
    reissue.states = [{ Failed: "spent" }];
    await desk.onPayment("l", { id: "p2", timestamp: 2, amount: { value: "1000", asset: "sat" }, endpoint: [ENDPOINT.fedimint, notes] });
    expect(desk.payment("p2")).toMatchObject({ state: "failed", token: undefined });
    expect(sent).toEqual([expect.objectContaining({ ok: false, error: "These notes were already redeemed" })]);
    expect(lines()).toEqual(["Could not receive Fedimint ecash: These notes were already redeemed"]);
  });

  it("pasted on the wallet page: says the federation was not heard from, not that the notes were redeemed", async () => {
    const { w, notes } = await walletWithNotes();
    reissue.error = "The Fedimint client stopped: worker gone";
    await expect(w.receiveNotes(notes)).rejects.toThrow(engineText("fedimintRedeemUnheard"));
    reissue.error = undefined; reissue.states = [{ Failed: "spent" }];
    await expect(w.receiveNotes(notes)).rejects.toThrow("already redeemed");
  });
});
