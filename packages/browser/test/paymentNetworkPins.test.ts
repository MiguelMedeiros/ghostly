import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ENDPOINT, cashuRequestPayload, type GhostLink, type PaymentMethodName, type PaymentRequest, type PaymentTarget, type WalletNetwork } from "@ghostly/core";
import { PaymentDesk, type DeskLightning } from "../src/engine/payments";
import type { CashuWallet } from "../src/engine/wallet";
import { STORES, openDb, transact } from "../src/shared/idb";
import { TEST_MINT } from "../src/shared/mints";
import { REAL_MONEY_UNCONFIRMED } from "../src/engine/paymentAdapters/walletInstances";
import { fakeInvoice } from "../src/engine/paymentAdapters/providers/testing";
// covers: payments.chat.networks, payments.chat.methods, payments.usdt.send, payments.mainnet-confirm

/**
 * What a contact's request can make this side spend: only money of the request's own network (a Testnet request
 * listing a real mint never has real ecash spent on it), only on a way this chat takes on that network, and real
 * money only once the person confirmed it as such.
 */

const REAL = "https://mint.minibits.cash/Bitcoin";
/** A regtest invoice: a test chain's, whatever mint made it. */
const TEST_CHAIN_INVOICE = fakeInvoice(100, new Uint8Array(32).fill(7));

function setup(accepts: (method: PaymentMethodName, network: WalletNetwork) => boolean = () => true) {
  const link = {
    isDataLinkOpen: true, supportsPayments: true, supportsUsdtPayments: true,
    requirePaymentSupport: vi.fn(async () => {}),
    allowsPayment: vi.fn(() => true),
    paymentEnabled: vi.fn(() => true),
    sendPaymentRequest: vi.fn(async () => {}),
    sendPayment: vi.fn(async () => {}),
    sendPaymentResult: vi.fn(),
  };
  const wallet = {
    createToken: vi.fn(async (_amount: number, mints?: string[]) => ({ token: "cashuBtoken", mint: mints?.[0] ?? TEST_MINT })),
    view: vi.fn(async (network?: string) => ({ mints: [{ url: network === "testnet" ? TEST_MINT : REAL }] })),
  };
  const lightning = () => ({ createInvoice: vi.fn(), quote: vi.fn(async () => ({ quote: "q", amount: 100, feeReserve: 1 })), pay: vi.fn(async () => true) });
  const lightnings = { mainnet: lightning(), testnet: lightning() };
  const desk = new PaymentDesk(wallet as unknown as CashuWallet, {
    getLink: () => link as unknown as GhostLink,
    storeMessage: vi.fn(async () => {}),
    onChange: vi.fn(),
    acceptsNetwork: (_linkId, method, network) => accepts(method, network),
  }, undefined, undefined, undefined, lightnings as unknown as { mainnet: DeskLightning; testnet: DeskLightning });
  return { desk, link, wallet, lightnings };
}

const request = (id: string, network: WalletNetwork | undefined, endpoints: [string, string][]): PaymentRequest =>
  ({ id, timestamp: 1, amount: { value: "100", asset: "sat" }, endpoints, ...(network ? { network } : {}) });

beforeEach(async () => {
  await openDb();
  await transact([STORES.payments], (s) => s[STORES.payments].clear());
});

describe("a request keeps only what is of its own network", () => {
  it("a Testnet request naming a real mint keeps only its test mints; with only real ones it is dropped", async () => {
    const { desk } = setup();
    await desk.onPaymentRequest("l", request("mixed", "testnet", [[ENDPOINT.cashu, cashuRequestPayload([REAL, TEST_MINT])]]));
    expect(desk.payment("mixed")).toMatchObject({ network: "testnet", mints: [TEST_MINT] });
    await desk.onPaymentRequest("l", request("real-only", "testnet", [[ENDPOINT.cashu, cashuRequestPayload([REAL])]]));
    expect(desk.payment("real-only")).toBeUndefined();
    // And the other way round: a Mainnet request never counts a test mint as a way to pay it.
    await desk.onPaymentRequest("l", request("main", "mainnet", [[ENDPOINT.cashu, cashuRequestPayload([TEST_MINT, REAL])]]));
    expect(desk.payment("main")).toMatchObject({ network: "mainnet", mints: [REAL] });
  });

  it("a Mainnet request drops an invoice of a test chain; a Testnet one keeps an lnbc invoice (a test mint's look the same)", async () => {
    const { desk } = setup();
    await desk.onPaymentRequest("l", request("main", "mainnet", [[ENDPOINT.bolt11, TEST_CHAIN_INVOICE], [ENDPOINT.cashu, cashuRequestPayload([REAL])]]));
    expect(desk.payment("main")).toMatchObject({ mints: [REAL] });
    expect(desk.payment("main")?.invoice).toBeUndefined();
    await desk.onPaymentRequest("l", request("main-invoice-only", "mainnet", [[ENDPOINT.bolt11, TEST_CHAIN_INVOICE]]));
    expect(desk.payment("main-invoice-only")).toBeUndefined();
    await desk.onPaymentRequest("l", request("test", "testnet", [[ENDPOINT.bolt11, TEST_CHAIN_INVOICE]]));
    expect(desk.payment("test")).toMatchObject({ network: "testnet", invoice: TEST_CHAIN_INVOICE });
  });

  it("the ecash that pays a Testnet request is asked of the Testnet mints only, and needs no confirmation", async () => {
    const { desk, wallet } = setup();
    await desk.onPaymentRequest("l", request("r", "testnet", [[ENDPOINT.cashu, cashuRequestPayload([REAL, TEST_MINT])]]));
    await desk.payRequest({ linkId: "l", paymentId: "r" });
    expect(wallet.createToken).toHaveBeenCalledWith(100, [TEST_MINT], undefined, expect.any(Function), "testnet");
  });
});

describe("real money needs its confirmation", () => {
  it("paying a Mainnet request without confirmedReal spends nothing, by ecash or Lightning", async () => {
    const { desk, wallet, lightnings } = setup();
    await desk.onPaymentRequest("l", request("r", "mainnet", [[ENDPOINT.bolt11, "lnbc100n1invoice"], [ENDPOINT.cashu, cashuRequestPayload([REAL])]]));
    for (const via of [undefined, "lightning"] as const) await expect(desk.payRequest({ linkId: "l", paymentId: "r", via }), via ?? "ecash").rejects.toThrow(REAL_MONEY_UNCONFIRMED);
    expect(wallet.createToken).not.toHaveBeenCalled();
    expect(lightnings.mainnet.quote).not.toHaveBeenCalled();
    expect(desk.payment("r")).toMatchObject({ state: "pending" });
    await desk.payRequest({ linkId: "l", paymentId: "r", confirmedReal: true });
    expect(wallet.createToken).toHaveBeenCalledWith(100, [REAL], undefined, expect.any(Function), "mainnet");
  });

  it("sending Mainnet ecash without confirmedReal makes no token; Testnet ecash needs nothing", async () => {
    const { desk, wallet } = setup();
    await expect(desk.send({ linkId: "l", amount: 5, timestamp: 1, network: "mainnet" })).rejects.toThrow(REAL_MONEY_UNCONFIRMED);
    expect(wallet.createToken).not.toHaveBeenCalled();
    await desk.send({ linkId: "l", amount: 5, timestamp: 2, network: "testnet" });
    await desk.send({ linkId: "l", amount: 5, timestamp: 3, network: "mainnet", confirmedReal: true });
    expect(wallet.createToken).toHaveBeenCalledTimes(2);
  });
});

describe("a USDT request and the chat's Accept side", () => {
  const sepolia = (): PaymentTarget => ({ method: "usdt", network: "sepolia", provider: "https://ethereum-sepolia-rpc.publicnode.com", asset: "TEST-USDT", unit: "token-base", chainId: 11155111,
    token: "0x" + "1".repeat(40), decimals: 6, address: "0x" + "2".repeat(40), issuedAt: Date.now() - 1_000, expiresAt: Date.now() + 60_000 });
  const usdt = (id: string, network?: WalletNetwork): PaymentRequest => ({ id, timestamp: 1, amount: { value: "1000000", asset: "testusdt" }, endpoints: [[ENDPOINT.usdt, JSON.stringify(sepolia())]], ...(network ? { network } : {}) });

  it("is refused in a chat with Testnet USDT off, and shown where it is on", async () => {
    const off = setup((method, network) => !(method === "usdt" && network === "testnet"));
    await off.desk.onPaymentRequest("l", usdt("u1", "testnet"));
    expect(off.desk.payment("u1")).toBeUndefined();
    const on = setup();
    await on.desk.onPaymentRequest("l", usdt("u2", "testnet"));
    expect(on.desk.payment("u2")).toMatchObject({ kind: "request", direction: "in", unit: "testusdt", network: "testnet" });
  });

  it("is dropped when it names another network than its chain's", async () => {
    const { desk } = setup();
    await desk.onPaymentRequest("l", usdt("u", "mainnet"));
    expect(desk.payment("u")).toBeUndefined();
  });
});
