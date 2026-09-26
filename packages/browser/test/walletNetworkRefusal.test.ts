import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ENDPOINT, WALLET_NETWORKS, cashuRequestPayload, type GhostLink, type PaymentTarget } from "@ghostly/core";
import { PaymentDesk, type DeskLightning } from "../src/engine/payments";
import type { ArkWallet } from "../src/engine/paymentAdapters/arkWallet";
import type { CashuWallet } from "../src/engine/wallet";
import { STORES, openDb, transact } from "../src/shared/idb";
import { TEST_MINT } from "../src/shared/mints";
import { crossNetwork, paymentNetwork, paymentNetworksOf, walletInstances } from "../src/engine/paymentAdapters/walletInstances";
import { WrongNetworkError } from "../src/engine/paymentAdapters/modeGate";
import { GhostlyNode } from "../src/engine/node";
import type { NetworkWalletsView, StoredPayment } from "../src/shared/types";
// covers: wallet.instances.networks, payments.chat.networks

const REAL = "https://mint.minibits.cash/Bitcoin";
const arkTarget = (network: "bitcoin" | "mutinynet", address = "tark1fresh"): PaymentTarget => ({ method: "arkade", network, provider: network === "bitcoin" ? "https://arkade.computer" : "https://mutinynet.arkade.sh", asset: "BTC", unit: "sat", address, expiresAt: Date.now() + 3_600_000 });

function setup() {
  const sent: { kind: string; frame: Record<string, unknown> }[] = [];
  const link = {
    isDataLinkOpen: true, supportsPayments: true, supportsArkPayments: true, supportsBarkPayments: true, supportsBitcoinPayments: true, supportsUsdtPayments: true,
    requirePaymentSupport: vi.fn(async () => {}),
    allowsPayment: vi.fn(() => true),
    paymentEnabled: vi.fn(() => true),
    sendPaymentRequest: vi.fn(async (frame: Record<string, unknown>) => { sent.push({ kind: "req", frame }); }),
    sendPaymentAsk: vi.fn(async (frame: Record<string, unknown>) => { sent.push({ kind: "ask", frame }); }),
    sendPayment: vi.fn(async (frame: Record<string, unknown>) => { sent.push({ kind: "pay", frame }); }),
    sendPaymentResult: vi.fn(),
  };
  const wallet = {
    createToken: vi.fn(async () => { throw new Error("You share no mint with this contact"); }),
    view: vi.fn(async (network?: string) => ({ mints: [{ url: network === "testnet" ? TEST_MINT : REAL }] })),
  };
  const lightning = (network: string) => ({ createInvoice: vi.fn(async () => ({ invoice: `lnbc-${network}` })), quote: vi.fn(async () => ({ quote: "q", amount: 100, feeReserve: 1 })), pay: vi.fn(async () => true) });
  const lightnings = { mainnet: lightning("mainnet"), testnet: lightning("testnet") };
  // A Testnet Ark wallet only: the Mainnet one was never made.
  const arks = {
    mainnet: { configured: false, target: vi.fn(), adapter: undefined },
    testnet: { configured: true, target: vi.fn(async () => arkTarget("mutinynet")), adapter: undefined },
  };
  const desk = new PaymentDesk(wallet as unknown as CashuWallet, {
    getLink: () => link as unknown as GhostLink,
    storeMessage: vi.fn(async () => {}),
    onChange: vi.fn(),
  }, arks as unknown as { mainnet: ArkWallet; testnet: ArkWallet }, undefined, undefined, lightnings as unknown as { mainnet: DeskLightning; testnet: DeskLightning });
  return { desk, link, sent, wallet, lightnings, arks };
}

beforeEach(async () => {
  await openDb();
  await transact([STORES.payments], (s) => s[STORES.payments].clear());
});

describe("a payment never crosses networks", () => {
  it("a request of one network is refused by a card of the other, before anything is spent", async () => {
    const { desk, wallet, lightnings } = setup();
    await desk.onPaymentRequest("l", { id: "real-one", timestamp: 1, amount: { value: "100", asset: "sat" }, endpoints: [[ENDPOINT.bolt11, "lnbc100"], [ENDPOINT.cashu, cashuRequestPayload([REAL])]], network: "mainnet" });
    await expect(desk.payRequest({ linkId: "l", paymentId: "real-one", network: "testnet" })).rejects.toThrow(crossNetwork("testnet", "mainnet"));
    expect(wallet.createToken).not.toHaveBeenCalled();
    expect(lightnings.testnet.pay).not.toHaveBeenCalled();
    expect(lightnings.mainnet.pay).not.toHaveBeenCalled();
    // Paid with no card named, it goes through the request's own network: Mainnet's Lightning, never Testnet's.
    await desk.payRequest({ linkId: "l", paymentId: "real-one", confirmedReal: true });
    expect(lightnings.mainnet.quote).toHaveBeenCalledWith("lnbc100");
    expect(lightnings.testnet.quote).not.toHaveBeenCalled();
  });

  it("an incoming request keeps the network it names, else the one its mints, chain or invoice say", async () => {
    const { desk } = setup();
    const req = (id: string, endpoints: [string, string][], network?: "mainnet" | "testnet") => desk.onPaymentRequest("l", { id: `req-${id}`, timestamp: 1, amount: { value: "10", asset: "sat" }, endpoints, network });
    await req("named", [[ENDPOINT.bolt11, "lnbc10"]], "testnet");
    await req("test-mint", [[ENDPOINT.bolt11, "lnbc10"], [ENDPOINT.cashu, cashuRequestPayload([TEST_MINT])]]);
    await req("real-mint", [[ENDPOINT.cashu, cashuRequestPayload([REAL])]]);
    await req("ark", [[ENDPOINT.arkade, JSON.stringify(arkTarget("mutinynet"))]]);
    expect(["named", "test-mint", "real-mint", "ark"].map((id) => desk.payment(`req-${id}`)?.network)).toEqual(["testnet", "testnet", "mainnet", "testnet"]);
  });

  it("a request is made on the card's network, and says so on the wire; a network with no such wallet refuses", async () => {
    const { desk, sent, lightnings } = setup();
    await desk.request({ linkId: "l", amount: 21, timestamp: 1, network: "testnet" });
    expect(sent.at(-1)?.frame).toMatchObject({ network: "testnet", endpoints: [[ENDPOINT.bolt11, "lnbc-testnet"], [ENDPOINT.cashu, cashuRequestPayload([TEST_MINT])]] });
    expect(lightnings.mainnet.createInvoice).not.toHaveBeenCalled();
    await desk.request({ linkId: "l", amount: 21, timestamp: 2, method: "arkade", network: "testnet" });
    expect(sent.at(-1)?.frame).toMatchObject({ network: "testnet" });
    await expect(desk.request({ linkId: "l", amount: 21, timestamp: 3, method: "arkade", network: "mainnet" })).rejects.toThrow("You have no Mainnet Ark wallet");
  });

  it("an ask says the payer's network, and the payee answers from its wallet of that network, or not at all", async () => {
    const { desk, sent, arks } = setup();
    await desk.ask({ linkId: "l", amount: 50, method: "arkade", timestamp: 1, network: "testnet" });
    expect(sent.at(-1)).toMatchObject({ kind: "ask", frame: { network: "testnet" } });
    // The other way round: the contact asks to pay on Testnet, and this side's Testnet Ark wallet answers.
    await desk.onPaymentAsk("l", { id: "ask-test-1", timestamp: 1, amount: { value: "50", asset: "sat" }, method: "arkade", network: "testnet" });
    expect(sent.at(-1)).toMatchObject({ kind: "req", frame: { ask: "ask-test-1", network: "testnet" } });
    // A Mainnet ask finds no Mainnet Ark wallet here: no answer, nothing made.
    const count = sent.length;
    await new Promise((resolve) => setTimeout(resolve, 3_100));
    await desk.onPaymentAsk("l", { id: "ask-main-1", timestamp: 2, amount: { value: "50", asset: "sat" }, method: "arkade", network: "mainnet" });
    expect(sent).toHaveLength(count);
    expect(arks.mainnet.target).not.toHaveBeenCalled();
  });

  it("an answer on the other network does not answer the ask it names", async () => {
    const { desk } = setup();
    const { askId } = await desk.ask({ linkId: "l", amount: 50, method: "arkade", timestamp: 1, network: "testnet" });
    await desk.onPaymentRequest("l", { id: "wrong-net", timestamp: 2, amount: { value: "50", asset: "sat" }, endpoints: [[ENDPOINT.arkade, JSON.stringify(arkTarget("bitcoin", "ark1fresh"))]], ask: askId, network: "mainnet" });
    expect(desk.payment("wrong-net")?.ask).toBeUndefined();
    await desk.onPaymentRequest("l", { id: "right-net", timestamp: 3, amount: { value: "50", asset: "sat" }, endpoints: [[ENDPOINT.arkade, JSON.stringify(arkTarget("mutinynet"))]], ask: askId, network: "testnet" });
    expect(desk.payment("right-net")?.ask).toBe(askId);
  });
});

describe("the wallets and their networks", () => {
  const empty = (): NetworkWalletsView => ({ mints: [], balance: 0, history: [], feesPaid: 0 });
  it("lists one wallet per type and network, in the deck's order, with only what can be shown", () => {
    const mainnet = { ...empty(), mints: [{ url: REAL, name: "Minibits", balance: 5, info: null }], lightning: { providerId: "cashu-mint", label: "Cashu mints", mode: "mainnet", status: "ready", offered: [], recent: [] } } as NetworkWalletsView;
    const testnet = { ...empty(), ark: { configured: true, locked: true, balance: 0, network: "mutinynet", provider: "https://mutinynet.arkade.sh" }, usdt: { configured: false, locked: true, balance: "0", gasBalance: "0" }, lightning: { providerId: "cashu-mint", mode: "testnet", status: "connecting", offered: [], recent: [] } } as NetworkWalletsView;
    const list = walletInstances({ mainnet, testnet });
    expect(list.map((w) => w.id)).toEqual(["cashu:mainnet", "lightning:mainnet", "arkade:testnet"]);
    expect(list[2]).toEqual({ id: "arkade:testnet", type: "arkade", network: "testnet", config: { chain: "mutinynet", provider: "https://mutinynet.arkade.sh" } });
    expect(paymentNetworksOf(list)).toEqual({ cashu: ["mainnet"], lightning: ["mainnet"], arkade: ["testnet"] });
  });

  it("reads the network of an older record from what it carries", () => {
    const base = { id: "p", linkId: "l", kind: "request", direction: "in", amount: 1, unit: "sat", state: "pending", createdAt: 1 } as StoredPayment;
    expect(paymentNetwork({ ...base, network: "testnet", mints: [REAL] })).toBe("testnet");
    expect(paymentNetwork({ ...base, mints: [TEST_MINT], invoice: "lnbc1" })).toBe("testnet");
    expect(paymentNetwork({ ...base, mint: REAL })).toBe("mainnet");
    expect(paymentNetwork({ ...base, target: arkTarget("mutinynet") })).toBe("testnet");
    expect(paymentNetwork({ ...base, target: { ...arkTarget("bitcoin"), method: "cashu", provider: TEST_MINT } })).toBe("testnet");
    expect(paymentNetwork(base), "nothing to tell: real money, the careful default").toBe("mainnet");
  });

  it("a wallet backup goes into the wallet of its own network, whichever was asked", async () => {
    const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { automaticWallets: false });
    const mainnet = vi.spyOn(node["arkWallets"].mainnet, "restoreBackup").mockRejectedValue(new WrongNetworkError("testnet", "This backup is a Testnet Ark wallet"));
    const testnet = vi.spyOn(node["arkWallets"].testnet, "restoreBackup").mockResolvedValue(undefined);
    const ready = vi.spyOn(node["arkWallets"].testnet, "ensureReady").mockResolvedValue(undefined);
    await node.arkRestoreBackup({ text: "backup", password: "a chosen password" });
    expect(mainnet).toHaveBeenCalledOnce();
    expect(testnet).toHaveBeenCalledWith("backup", "a chosen password");
    expect(ready).toHaveBeenCalledOnce();
    // Any other refusal is the answer: nothing is tried elsewhere.
    mainnet.mockRejectedValueOnce(new Error("Wrong password"));
    await expect(node.arkRestoreBackup({ text: "backup", password: "wrong" })).rejects.toThrow("Wrong password");
    expect(testnet).toHaveBeenCalledOnce();
  });
});

describe("a chat's ways of paying, per network", () => {
  it("a network this chat has off for a way of paying is refused both ways, and the other network still works", async () => {
    const { desk, sent, link, wallet } = setup();
    const accepts = vi.fn((_linkId: string, method: string, network: string) => !(method === "cashu" && network === "testnet"));
    (desk as unknown as { host: { acceptsNetwork: typeof accepts } }).host.acceptsNetwork = accepts;
    // An incoming Testnet Cashu request is dropped; a Mainnet one is kept.
    await desk.onPaymentRequest("l", { id: "test-cashu", timestamp: 1, amount: { value: "10", asset: "sat" }, endpoints: [[ENDPOINT.cashu, cashuRequestPayload([TEST_MINT])]], network: "testnet" });
    await desk.onPaymentRequest("l", { id: "real-cashu", timestamp: 2, amount: { value: "10", asset: "sat" }, endpoints: [[ENDPOINT.cashu, cashuRequestPayload([REAL])]], network: "mainnet" });
    expect(desk.payment("test-cashu")).toBeUndefined();
    expect(desk.payment("real-cashu")?.network).toBe("mainnet");
    // Test ecash from the contact is refused unredeemed.
    Object.assign(wallet, { inspect: () => ({ kind: "token", mint: TEST_MINT, amount: 5, unit: "sat", accepted: true }), receiveToken: vi.fn() });
    await desk.onPayment("l", { id: "token-1", timestamp: 3, amount: { value: "5", asset: "sat" }, endpoint: [ENDPOINT.cashu, "cashuBtest"] });
    expect(link.sendPaymentResult).toHaveBeenCalledWith({ id: "token-1", ok: false, error: "Testnet Cashu is off in this chat" });
    expect((wallet as unknown as { receiveToken: ReturnType<typeof vi.fn> }).receiveToken).not.toHaveBeenCalled();
    // Sending or requesting on it from here is refused before anything is made.
    await expect(desk.request({ linkId: "l", amount: 21, timestamp: 4, rail: "cashu", network: "testnet" })).rejects.toThrow("Testnet Cashu is off in this chat");
    const before = sent.length;
    await desk.request({ linkId: "l", amount: 21, timestamp: 5, network: "testnet" });
    // Testnet Lightning is still on: the request carries only the invoice.
    expect(sent.length).toBe(before + 1);
    expect(sent.at(-1)?.frame).toMatchObject({ network: "testnet", endpoints: [[ENDPOINT.bolt11, "lnbc-testnet"]] });
  });

  it("a contact that said its networks is offered only those: a Testnet card never goes to a Mainnet-only contact", async () => {
    const { desk, link } = setup();
    Object.assign(link, { peerPaymentNetworks: (method: string) => method === "arkade" ? ["mainnet"] : ["mainnet", "testnet"] });
    await expect(desk.request({ linkId: "l", amount: 21, timestamp: 1, method: "arkade", network: "testnet" })).rejects.toThrow("Your contact has no Testnet Ark wallet");
    await expect(desk.ask({ linkId: "l", amount: 21, method: "arkade", timestamp: 2, network: "testnet" })).rejects.toThrow("Your contact has no Testnet Ark wallet");
    // An older contact says nothing: anything may meet.
    Object.assign(link, { peerPaymentNetworks: () => undefined });
    await expect(desk.request({ linkId: "l", amount: 21, timestamp: 3, method: "arkade", network: "testnet" })).resolves.toHaveProperty("paymentId");
  });

  it("the engine keeps each chat's networks, and tells the contact only the networks it has wallets on and the chat takes", async () => {
    const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { automaticWallets: false });
    node["emitState"] = () => {};
    node["walletView"] = { ...node["walletView"], wallets: [
      { id: "cashu:mainnet", type: "cashu", network: "mainnet", config: {} }, { id: "cashu:testnet", type: "cashu", network: "testnet", config: {} },
      { id: "arkade:testnet", type: "arkade", network: "testnet", config: {} },
    ] };
    const setPaymentNetworks = vi.fn(), setPaymentMethods = vi.fn();
    node["links"].set("chat", { stored: { id: "chat" }, link: { setPaymentNetworks, setPaymentMethods } } as never);
    const patch = vi.spyOn((await import("../src/engine/db")).db, "patchLink").mockResolvedValue(undefined);
    await node.setChatPaymentMethods({ linkId: "chat", methods: { cashu: true }, networks: { cashu: ["mainnet"] } });
    expect(patch).toHaveBeenCalledWith("chat", { paymentMethods: { cashu: true }, paymentNetworks: { cashu: ["mainnet"] } });
    expect(setPaymentNetworks).toHaveBeenLastCalledWith({ cashu: ["mainnet"], arkade: ["testnet"] });
    expect(node["acceptsNetwork"](node["links"].get("chat")!.stored, "cashu", "testnet")).toBe(false);
    expect(node["acceptsNetwork"](node["links"].get("chat")!.stored, "arkade", "testnet"), "a way with no choice takes every network").toBe(true);
    await expect(node.setChatPaymentMethods({ linkId: "chat", methods: {}, networks: { cashu: ["signet" as never] } })).rejects.toThrow("Chat not found");
    patch.mockRestore();
  });
});

it("a new profile starts with no wallet: no mint and nothing else is made by itself", async () => {
  const { db } = await import("../src/engine/db");
  await transact([STORES.settings], (s) => s[STORES.settings].clear());
  const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { automaticWallets: true, transport: { publish: async () => {}, resolve: async () => null, describe: () => ({ protocol: "fixture", relays: [] }) } as never });
  const created = WALLET_NETWORKS.flatMap((n) => [vi.spyOn(node["arkWallets"][n], "createDefaultNow"), vi.spyOn(node["usdtWallets"][n], "createDefaultNow")]);
  await db.putSettings({ online: false, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: false });
  await node.start();
  expect(node["settings"].mints).toEqual([]);
  expect(node.getState().wallet.wallets).toEqual([]);
  for (const spy of created) expect(spy).not.toHaveBeenCalled();
  expect(node["arkWallets"].testnet.configured || node["usdtWallets"].mainnet.configured).toBe(false);
  await node.shutdown();
});
