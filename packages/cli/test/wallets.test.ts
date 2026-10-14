import { validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EngineState } from "@ghostly/browser/shared/types";
import { normalizeMintUrl } from "@ghostly/browser/engine/wallet";
import { callApi, type ApiContext } from "../src/api";
import { asCliError } from "../src/errors";
import { invoiceNetwork } from "../src/wallets";
// covers: headless.wallets, headless.payments, headless.engine-passthrough

/** The wallet and payment methods over a fake engine: what they refuse before the engine is asked. */
function fake() {
  const node = {
    getState: () => ({
      links: [
        { id: "chat-one", label: "Alice", peerPubKeyZ32: "p", createdAt: 1, lastMessageAt: 0, profile: "paired-chat/1" },
        // An invite nobody took yet.
        { id: "chat-two", label: "Bob", peerPubKeyZ32: "q", createdAt: 1, lastMessageAt: 0, profile: "paired-chat/1", inviteCode: "ghostly1code", pairing: { status: "waiting" }, pairingProgress: { stage: "waiting", role: "inviter", startedAt: 1 } },
      ],
      groups: [],
      payments: {
        req: { id: "req", linkId: "chat-one", kind: "request", direction: "in", amount: 5, unit: "sat", state: "pending", createdAt: 2, network: "mainnet" },
        test: { id: "test", linkId: "chat-one", kind: "request", direction: "in", amount: 5, unit: "sat", state: "pending", createdAt: 1, network: "testnet" },
      },
      settings: {},
      wallet: {
        wallets: [{ id: "cashu:testnet", type: "cashu", network: "testnet", config: {} }, { id: "lightning:testnet:cashu", type: "lightning", network: "testnet", config: {}, card: "cashu", name: "Cashu", receive: true }],
        offers: [{ type: "bark", network: "testnet", available: true }, { type: "cashu", network: "testnet", available: true },
          { type: "bitcoin", network: "testnet", available: true, needs: "provider", providers: [{ id: "bdk", label: "BDK", fields: [] }] }],
        networks: { testnet: { mints: [], balance: 42, history: [{ id: "h" }], feesPaid: 0, lightnings: [{ card: "cashu", balance: 42, status: "ready" }] }, mainnet: { mints: [], balance: 0, history: [], feesPaid: 0 } },
      },
    }) as unknown as EngineState,
    walletCreate: vi.fn(async (p: { type: string; network: string }) => ({ id: `${p.type}:${p.network}`, type: p.type, network: p.network, config: {} })),
    walletRemove: vi.fn(async (_: unknown): Promise<void> => { throw new Error("This wallet still holds 42 sats on this device"); }),
    walletTestCoins: vi.fn(async () => ({ amount: 10000, unit: "test sats" })),
    walletQuoteInvoice: vi.fn(async () => ({ quote: "q", mint: "m", amount: 10, feeReserve: 3 })),
    walletPayQuote: vi.fn(async (_: unknown) => ({ paid: true })),
    sendPayment: vi.fn(async (_: { timestamp: number }) => ({ paymentId: "p1" })),
    requestPayment: vi.fn(async (_: { timestamp: number }) => ({ paymentId: "r1" })),
    payRequest: vi.fn(async (_: unknown) => undefined),
    // As the engine checks a mint's URL before it reaches for the mint.
    walletAddMint: vi.fn(async (p: { url: string }) => ({ url: normalizeMintUrl(p.url) })),
    walletReceiveLightning: vi.fn(async (_: unknown) => ({ invoice: "lntbs1x", expiresAt: 1, source: "m" })),
    walletReceiveToken: vi.fn(async (_: unknown) => ({ amount: 1 })),
    bitcoinReceiveAddress: vi.fn(async (_: unknown) => "tb1q"),
    connect: vi.fn(async (_: unknown) => undefined),
  };
  const ctx = { runtime: { server: { node }, paths: { name: "default" } }, hub: { onEvent: () => () => {}, onState: () => () => {} }, mode: "daemon", version: "t" } as unknown as ApiContext;
  return { ctx, node };
}

describe("wallets", () => {
  it("list with balances, and mark what Node cannot run", async () => {
    const { ctx } = fake();
    const listed = await callApi(ctx, "wallet.list", {}) as { wallets: { type: string; balance: number }[]; offers: { type: string; available: boolean; reason: string | null }[] };
    expect(listed.wallets.map((w) => [w.type, w.balance])).toEqual([["cashu", 42], ["lightning", 42]]);
    expect(listed.offers.find((o) => o.type === "bark")).toMatchObject({ available: false, reason: expect.stringMatching(/browser/) });
  });

  it("refuse Bark before the engine, pass Fedimint's invite on, and draw a BDK phrase that is never answered", async () => {
    const { ctx, node } = fake();
    await expect(callApi(ctx, "wallet.create", { type: "bark" })).rejects.toMatchObject({ code: "unavailable" });
    expect(node.walletCreate).not.toHaveBeenCalled();
    await callApi(ctx, "wallet.create", { type: "fedimint", invite: "fed1x" });
    expect(node.walletCreate.mock.calls.at(-1)![0]).toMatchObject({ type: "fedimint", network: "testnet", invite: "fed1x" });
    const made = await callApi(ctx, "wallet.create", { type: "bitcoin", values: { network: "signet", script: "bip84" } });
    const asked = node.walletCreate.mock.calls.at(-1)![0] as unknown as { providerId: string; values: { mnemonic: string } };
    expect(asked.providerId).toBe("bdk");
    expect(validateMnemonic(asked.values.mnemonic, wordlist)).toBe(true);
    expect(JSON.stringify(made)).not.toContain(asked.values.mnemonic);
  });

  it("removal holding money needs the person's acceptLoss", async () => {
    const { ctx, node } = fake();
    await expect(callApi(ctx, "wallet.remove", { type: "cashu" })).rejects.toMatchObject({ code: "confirm" });
    await expect(callApi(ctx, "wallet.remove", { type: "cashu", acceptLoss: true })).rejects.toThrow(/still holds/);
    expect(node.walletRemove.mock.calls.at(-1)![0]).toMatchObject({ acceptLoss: true });
  });

  it("a --card is a Lightning card on the network: with another type it is usage, unknown it is not_found, before the engine", async () => {
    const { ctx, node } = fake();
    await expect(callApi(ctx, "wallet.remove", { type: "cashu", card: "no-such-card", acceptLoss: true })).rejects.toMatchObject({ code: "usage", message: "--card names a Lightning card: not with cashu" });
    await expect(callApi(ctx, "wallet.remove", { type: "lightning", card: "no-such-card", acceptLoss: true })).rejects.toMatchObject({ code: "not_found" });
    await expect(callApi(ctx, "wallet.remove", { type: "lightning", card: "cashu", network: "mainnet", acceptLoss: true })).rejects.toMatchObject({ code: "not_found" });
    await expect(callApi(ctx, "wallet.faucet", { type: "cashu", card: "cashu" })).rejects.toMatchObject({ code: "usage" });
    await expect(callApi(ctx, "wallet.faucet", { type: "lightning", card: "no-such-card" })).rejects.toMatchObject({ code: "not_found" });
    await expect(callApi(ctx, "wallet.receive", { amount: 10, card: "no-such-card" })).rejects.toMatchObject({ code: "not_found" });
    expect(node.walletRemove).not.toHaveBeenCalled();
    expect(node.walletTestCoins).not.toHaveBeenCalled();
    node.walletRemove.mockResolvedValueOnce(undefined);
    expect(await callApi(ctx, "wallet.remove", { type: "lightning", card: "cashu" })).toEqual({ removed: { type: "lightning", network: "testnet", card: "cashu" } });
    expect(node.walletRemove.mock.calls.at(-1)![0]).toMatchObject({ type: "lightning", card: "cashu" });
    expect(await callApi(ctx, "wallet.faucet", { type: "lightning", card: "cashu" })).toEqual({ amount: 10000, unit: "test sats" });
  });

  it("the faucet is Testnet's only", async () => {
    const { ctx } = fake();
    await expect(callApi(ctx, "wallet.faucet", { type: "cashu", network: "mainnet" })).rejects.toMatchObject({ code: "refused" });
    expect(await callApi(ctx, "wallet.faucet", { type: "cashu" })).toEqual({ amount: 10000, unit: "test sats" });
  });

  it("a mint URL the engine refuses is the person's value: bad_request, with the engine's words", async () => {
    const { ctx } = fake();
    await expect(callApi(ctx, "wallet.mint.add", { url: "notaurl" })).rejects.toMatchObject({ code: "bad_request", message: "That is not a valid mint URL" });
    await expect(callApi(ctx, "wallet.mint.add", { url: "ftp://mint.example" })).rejects.toMatchObject({ code: "bad_request", message: "Mints must use https" });
    await expect(callApi(ctx, "wallet.mint.add", { url: "http://mint.example" })).rejects.toMatchObject({ code: "bad_request", message: "Mints must use https" });
    expect(await callApi(ctx, "wallet.mint.add", { url: "https://mint.example/" })).toEqual({ url: "https://mint.example" });
  });

  it("what the person asked for that is not there, not valid or already made is said with its code, not as the engine failing", async () => {
    // Found in a bug hunt: each of these was `engine` (exit 1), which a bot reads as the engine failing and may retry.
    const { ctx, node } = fake();
    const refused = (message: string) => new Error(message);
    const cases: [() => void, string, Record<string, unknown>, string][] = [
      [() => node.walletRemove.mockRejectedValueOnce(refused("There is no Testnet Cashu wallet to remove")), "wallet.remove", { type: "cashu" }, "not_found"],
      [() => node.walletRemove.mockRejectedValueOnce(refused("There is no Testnet Lightning wallet to remove")), "wallet.remove", { type: "lightning" }, "not_found"],
      // A card there when the CLI looked, gone when the engine did (one that is not there is refused before the engine).
      [() => node.walletReceiveLightning.mockRejectedValueOnce(refused("That Lightning card is gone: pick another")), "wallet.receive", { amount: 10, card: "cashu" }, "not_found"],
      [() => node.walletReceiveToken.mockRejectedValueOnce(refused("That is not a valid ecash token")), "wallet.redeem", { token: "hello" }, "bad_request"],
      [() => node.walletQuoteInvoice.mockRejectedValueOnce(refused("That is not a Lightning invoice")), "pay", { target: "lnbc1notaninvoice" }, "bad_request"],
      [() => node.walletCreate.mockRejectedValueOnce(refused("You already have a Testnet Cashu wallet")), "wallet.create", { type: "cashu" }, "refused"],
      [() => node.walletReceiveLightning.mockRejectedValueOnce(refused("No mint could create an invoice: No mint configured")), "wallet.receive", { amount: 10 }, "unavailable"],
      [() => node.requestPayment.mockRejectedValueOnce(refused("No mint could create an invoice: No mint configured")), "chat.request", { chat: "Alice", amount: 10 }, "unavailable"],
      [() => node.bitcoinReceiveAddress.mockRejectedValueOnce(refused("No Bitcoin source is set up")), "wallet.address", { type: "bitcoin" }, "unavailable"],
      [() => node.walletTestCoins.mockRejectedValueOnce(refused("The faucet did not pay: This wallet has no test mint to ask for test coins")), "wallet.faucet", { type: "cashu" }, "unavailable"],
      [() => node.walletTestCoins.mockRejectedValueOnce(refused("Ghostly cannot ask this wallet's faucet by itself: open it instead")), "wallet.faucet", { type: "bitcoin" }, "unavailable"],
    ];
    for (const [arrange, method, params, code] of cases) {
      arrange();
      // As the daemon answers it.
      const error = asCliError(await callApi(ctx, method, params).catch((e: unknown) => e));
      expect({ method, code: error.code, message: error.message }).toEqual({ method, code, message: expect.any(String) });
    }
    // A mint that did not answer stays the engine's.
    node.walletReceiveLightning.mockRejectedValueOnce(refused("No mint could create an invoice: mint.example did not answer"));
    expect(asCliError(await callApi(ctx, "wallet.receive", { amount: 10 }).catch((e: unknown) => e)).code).toBe("engine");
  });

  it("a wallet source that is not offered is the person's value, refused before the engine is asked", async () => {
    const { ctx, node } = fake();
    await expect(callApi(ctx, "wallet.create", { type: "bitcoin", provider: "nope" })).rejects.toMatchObject({ code: "bad_request", message: expect.stringContaining("ghostly wallet list") });
    expect(node.walletCreate).not.toHaveBeenCalled();
    await callApi(ctx, "wallet.create", { type: "bitcoin", provider: "bdk" });
    expect(node.walletCreate).toHaveBeenCalledOnce();
  });

  it("history takes a whole number of entries", async () => {
    const { ctx } = fake();
    await expect(callApi(ctx, "wallet.history", { limit: 1.5 })).rejects.toMatchObject({ code: "bad_request", message: "limit must be a whole number from 1 to 10000" });
    expect(await callApi(ctx, "wallet.history", { limit: 1 })).toEqual({ network: "testnet", history: [{ id: "h" }] });
  });
});

describe("real money", () => {
  it("an invoice's network comes from its prefix", () => {
    expect(invoiceNetwork("lnbc10u1pxyz")).toBe("mainnet");
    expect(invoiceNetwork("lightning:LNTBS1pxyz")).toBe("testnet");
    expect(invoiceNetwork("lnbcrt500n1pxyz")).toBe("testnet");
    expect(invoiceNetwork("hello")).toBeNull();
  });

  it("no spend on Mainnet without confirmReal, and confirmedReal only with it", async () => {
    const { ctx, node } = fake();
    await expect(callApi(ctx, "pay", { target: "lnbc10u1pxyz", network: "mainnet" })).rejects.toMatchObject({ code: "confirm" });
    await expect(callApi(ctx, "chat.pay", { chat: "Alice", amount: 5, network: "mainnet" })).rejects.toMatchObject({ code: "confirm" });
    await expect(callApi(ctx, "chat.payRequest", { chat: "Alice", payment: "req" })).rejects.toMatchObject({ code: "confirm" });
    expect(node.walletPayQuote).not.toHaveBeenCalled();
    expect(node.sendPayment).not.toHaveBeenCalled();
    expect(node.payRequest).not.toHaveBeenCalled();

    await callApi(ctx, "pay", { target: "lnbc10u1pxyz", network: "mainnet", confirmReal: true });
    expect(node.walletPayQuote).toHaveBeenCalledWith({ quote: "q", mint: "m", confirmedReal: true });
    await callApi(ctx, "chat.payRequest", { chat: "Alice", payment: "req", confirmReal: true });
    expect(node.payRequest.mock.calls.at(-1)![0]).toMatchObject({ network: "mainnet", confirmedReal: true });

    // Test coins (the default, whatever the invoice's prefix): nothing to confirm, and no confirmedReal passed.
    await callApi(ctx, "pay", { target: "lnbc10u1pxyz" });
    expect(node.walletPayQuote.mock.calls.at(-1)![0]).toEqual({ quote: "q", mint: "m" });
    await callApi(ctx, "chat.payRequest", { chat: "Alice", payment: "test" });
    expect(node.payRequest.mock.calls.at(-1)![0]).not.toHaveProperty("confirmedReal");
  });

  it("a fee above --max-fee is refused before paying", async () => {
    const { ctx, node } = fake();
    await expect(callApi(ctx, "pay", { target: "lntbs10u1pxyz", maxFee: 2 })).rejects.toMatchObject({ code: "refused" });
    expect(node.walletPayQuote).not.toHaveBeenCalled();
  });
});

describe("a chat whose invite nobody took", () => {
  it("pay and connect say so at once, before the engine dials a contact that is not there", async () => {
    // Found in a bug hunt: `chat pay` waited 15 s and `chat connect` 25 s, then answered `engine` "Could not connect to the peer".
    const { ctx, node } = fake();
    await expect(callApi(ctx, "chat.pay", { chat: "Bob", amount: 10 })).rejects.toMatchObject({ code: "unavailable", message: expect.stringMatching(/invite/) });
    await expect(callApi(ctx, "chat.connect", { chat: "Bob" })).rejects.toMatchObject({ code: "unavailable", message: expect.stringMatching(/invite/) });
    expect(node.sendPayment).not.toHaveBeenCalled();
    expect(node.connect).not.toHaveBeenCalled();
    expect(await callApi(ctx, "chat.pay", { chat: "Alice", amount: 10 })).toEqual({ chat: "chat-one", paymentId: "p1" });
  });
});

describe("payments in one millisecond", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  // The engine names a sent payment's or request's row after its time (`me_<timestamp>`): each needs its own, or the
  // chat keeps only one of them.
  it("give each payment and request its own time, never going back", async () => {
    const { ctx, node } = fake();
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    await Promise.all([
      callApi(ctx, "chat.pay", { chat: "Alice", amount: 1 }),
      callApi(ctx, "chat.pay", { chat: "Alice", amount: 2 }),
      callApi(ctx, "chat.request", { chat: "Alice", amount: 3 }),
    ]);
    await callApi(ctx, "chat.pay", { chat: "Alice", amount: 4 });
    const times = [...node.sendPayment.mock.calls.slice(0, 2), node.requestPayment.mock.calls[0]!, node.sendPayment.mock.calls[2]!].map(([p]) => p.timestamp);
    expect(new Set(times).size).toBe(4);
    expect(times[3]).toBeGreaterThan(Math.max(...times.slice(0, 3)));
  });
});
