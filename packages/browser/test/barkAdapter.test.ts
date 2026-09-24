import { beforeEach, expect, it } from "vitest";
import type { PaymentReview, PaymentTarget } from "@ghostly/core";
import { BarkAdapter, barkTiming, type BarkConfig } from "../src/engine/paymentAdapters/bark";
import { FakeBarkServer } from "./helpers/fakeBark";
// covers: payments.bark.send, wallet.bark.send

const provider = "https://ark.signet.2nd.dev", explorer = "https://esplora.signet.2nd.dev";
const MNEMONIC = "abandon ".repeat(11) + "about";
let server: FakeBarkServer;
const config = (): BarkConfig => ({ network: "signet", provider, explorer, serverKey: server.key, walletId: crypto.randomUUID() });
const review = (t: PaymentTarget, amount: number, fee: number): PaymentReview => ({ ...t, id: crypto.randomUUID(), payee: "bob", amount, fee, feeCap: 100, createdAt: Date.now(), state: "submitted" });
barkTiming.serverWaitMs = 1;
beforeEach(() => { server = new FakeBarkServer(); });

async function sentOnce() {
  const c = config(), alice = await BarkAdapter.connect(c, MNEMONIC, { sdk: server.sdk() }), bob = await BarkAdapter.connect(config(), MNEMONIC, { sdk: server.sdk() });
  const wallet = server.wallets.get(`ghostly-bark-${c.walletId}`)!;
  wallet.fund(10_000);
  const t: PaymentTarget = { method: "bark", network: "signet", provider, asset: "BTC", unit: "sat", address: await bob.requestAddress(), expiresAt: Date.now() + 60_000 };
  const { fee, prepared } = await alice.prepare(t, 500, 100);
  const r = review(t, 500, fee);
  await alice.execute(r, prepared, async () => {});
  return { alice, wallet, r, prepared };
}

it("a send the server refused is reported failed, and one still in flight stays pending, never resent", async () => {
  const { alice, wallet, r, prepared } = await sentOnce();
  const send = wallet.movements.find((m) => m.subsystemKind === "send")!;
  send.status = "pending";
  expect(await alice.reconcile(r, prepared)).toMatchObject({ settled: false, pending: true });
  send.status = "canceled";
  expect(await alice.reconcile(r, prepared)).toMatchObject({ settled: false, failed: true, error: expect.stringContaining("Nothing was sent") });
  expect(server.sent).toBe(1);
});

it("a send the SDK refuses for funds says so, without the SDK's own words", async () => {
  const c = config(), alice = await BarkAdapter.connect(c, MNEMONIC, { sdk: server.sdk() });
  const t: PaymentTarget = { method: "bark", network: "signet", provider, asset: "BTC", unit: "sat", address: `tark1p${server.tag}elsewhere`, expiresAt: Date.now() + 60_000 };
  const wallet = server.wallets.get(`ghostly-bark-${c.walletId}`)!;
  wallet.fund(1_000);
  const { fee, prepared } = await alice.prepare(t, 900, 100);
  wallet.sendArkoorPayment = async () => { throw new Error("Insufficient money available: vtxo 0f00…:0 locked by round 42"); };
  await expect(alice.execute(review(t, 900, fee), prepared, async () => {})).rejects.toThrow(/^Insufficient Bark balance$/);
  expect(server.sent).toBe(0);
});

it("the on-chain balance is still read when its sync fails", async () => {
  const c = config(), sdk = server.sdk(), open = sdk.open;
  sdk.open = async (params) => { const opened = await open(params); opened.onchain.sync = async () => { throw new Error("esplora down"); }; return opened; };
  const offline = await BarkAdapter.connect(c, MNEMONIC, { sdk });
  server.wallets.get(`ghostly-bark-${c.walletId}`)!.onchain = 4_200;
  expect((await offline.onchainBalance()).totalSats).toBe(4_200);
});
