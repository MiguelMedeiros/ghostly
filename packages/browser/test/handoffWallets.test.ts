import { describe, expect, it } from "vitest";
import { NETWORK_FIELDS, walletHandoffProblem } from "../src/devices/handoffWallets";
import type { MintView, NetworkWalletsView, WalletView } from "../src/shared/types";
import type { ArkWalletView } from "../src/engine/paymentAdapters/arkWallet";
import type { BarkWalletView } from "../src/engine/paymentAdapters/barkWallet";
import type { FedimintWalletView } from "../src/engine/paymentAdapters/fedimintWallet";
import type { SparkWalletView } from "../src/engine/paymentAdapters/sparkWallet";
import type { UsdtWalletView } from "../src/engine/paymentAdapters/usdtWallet";
import type { LightningCardView } from "../src/engine/paymentAdapters/providers/lightningCards";
import type { BitcoinView } from "../src/engine/paymentAdapters/providers/bitcoinService";
import type { PaymentReview } from "@ghostly/core";
// covers: devices.handoff.machine

/*
 * Until wallets move (WISP 06, part 8), a handoff refuses a profile that holds money, has a payment open, or has a
 * wallet whose holdings cannot be read now: the one rule that keeps money from being in two places. Wallet views of
 * the engine's own types, empty and not; it fails closed.
 */

const net = (extra: Partial<NetworkWalletsView> = {}): NetworkWalletsView => ({ mints: [], balance: 0, history: [], feesPaid: 0, awaiting: [], ...extra });
const view = (mainnet: Partial<NetworkWalletsView> = {}, testnet: Partial<NetworkWalletsView> = {}, extra: Partial<WalletView> = {}): WalletView => {
  const networks = { mainnet: net(mainnet), testnet: net(testnet) };
  return { ...networks.mainnet, networks, ...extra };
};
const mint = (balance: number, extra: Partial<MintView> = {}): MintView => ({ url: "https://mint.test", name: "Test", balance, info: null, ...extra });
const ark = (extra: Partial<ArkWalletView> = {}): ArkWalletView => ({ configured: true, locked: false, read: true, balance: 0, ...extra });
const bark = (extra: Partial<BarkWalletView> = {}): BarkWalletView => ({ configured: true, locked: false, read: true, balance: 0, ...extra });
const spark = (extra: Partial<SparkWalletView> = {}): SparkWalletView => ({ configured: true, locked: false, read: true, balance: 0, ...extra });
const usdt = (extra: Partial<UsdtWalletView> = {}): UsdtWalletView => ({ configured: true, locked: false, read: true, balance: "0", gasBalance: "0", ...extra });
const fedimint = (balance: number, status: "connecting" | "ready" | "error" = "ready"): FedimintWalletView => ({
  balance, history: [], federations: [{ id: "f", name: "Test", balance, status, read: true, lightning: true, invite: "fed1test" } as FedimintWalletView["federations"][number]],
});
const card = (extra: Partial<LightningCardView> = {}): LightningCardView => ({ mode: "testnet", status: "ready", read: true, offered: [], recent: [], card: "c1", name: "Card", receive: true, ...extra });
const bitcoin = (extra: Partial<BitcoinView> = {}): BitcoinView => ({ mode: "testnet", status: "ready", read: true, offered: [], history: [], ...extra });
const intent = (state: PaymentReview["state"]): PaymentReview => ({ state } as Partial<PaymentReview> as PaymentReview);

describe("money keeps a profile from moving", () => {
  it("nothing in any wallet, and only past payments in the history: it moves", () => {
    expect(walletHandoffProblem(view(), true)).toBeNull();
    expect(walletHandoffProblem(view({ mints: [mint(0)] }, { ark: ark(), bark: bark(), spark: spark(), usdt: usdt(), fedimint: fedimint(0), lightnings: [card({ balance: 0 })], bitcoin: bitcoin({ balance: 0 }) },
      { history: [{ id: "t", timestamp: 1, mint: "https://mint.test", kind: "ecash-in", amount: 500, fee: 0 }], intents: [intent("settled"), intent("failed"), intent("cancelled")] }), true)).toBeNull();
    // A wallet that was never set up (not configured) holds nothing, locked or not.
    expect(walletHandoffProblem(view({ ark: ark({ configured: false, locked: true }), usdt: usdt({ configured: false, locked: true }) }), true)).toBeNull();
  });

  it("before the wallets were read once: not known, so refused", () => {
    expect(walletHandoffProblem(view(), false)).toBe("loading");
  });

  it("ecash at a mint, on either network, or a flat balance", () => {
    expect(walletHandoffProblem(view({ balance: 21 }), true)).toBe("wallet");
    expect(walletHandoffProblem(view({}, { mints: [mint(8)] }), true)).toBe("wallet");
  });

  it("USDT, whose balance is text, and its gas", () => {
    expect(walletHandoffProblem(view({ usdt: usdt({ balance: "1500000" }) }), true)).toBe("wallet");
    expect(walletHandoffProblem(view({ usdt: usdt({ balance: "0.000001" }) }), true)).toBe("wallet");
    expect(walletHandoffProblem(view({ usdt: usdt({ gasBalance: "12" }) }), true)).toBe("wallet");
    // Text that is no number is not known to be nothing.
    expect(walletHandoffProblem(view({ usdt: usdt({ balance: "n/a" }) }), true)).toBe("wallet");
  });

  it("every amount field of Ark, Bark, on-chain, Spark, Fedimint and a Lightning card", () => {
    const cases: Partial<NetworkWalletsView>[] = [
      { ark: ark({ balance: 1 }) }, { ark: ark({ incoming: 2 }) }, { ark: ark({ recoverable: 3 }) }, { ark: ark({ sweeping: 4 }) }, { ark: ark({ small: 5 }) },
      { bark: bark({ balance: 6 }) }, { bark: bark({ pending: 7 }) }, { bark: bark({ exiting: 8 }) }, { bark: bark({ onchain: 9 }) },
      { bitcoin: bitcoin({ balance: 10 }) }, { bitcoin: bitcoin({ unconfirmed: 11 }) }, { spark: spark({ balance: 12 }) },
      { fedimint: fedimint(13) }, { lightnings: [card({ balance: 14 })] }, { lightning: card({ balance: 15 }) },
    ];
    for (const network of cases) {
      expect(walletHandoffProblem(view(network), true), JSON.stringify(network)).toBe("wallet");
      expect(walletHandoffProblem(view({ lightning: card({ capabilities: { balance: true } as LightningCardView["capabilities"] }) }), true), "a capability named balance is no amount").toBeNull();
      expect(walletHandoffProblem(view({}, network), true), `testnet ${JSON.stringify(network)}`).toBe("wallet");
    }
  });

  it("a wallet locked, still connecting or in error is not known to be empty", () => {
    const cases: Partial<NetworkWalletsView>[] = [
      { ark: ark({ locked: true }) }, { bark: bark({ error: "Connecting to Bark…" }) }, { spark: spark({ locked: true }) }, { usdt: usdt({ locked: true }) },
      { usdt: usdt({ error: "RPC unavailable. Balance may be stale." }) }, { fedimint: fedimint(0, "connecting") }, { fedimint: fedimint(0, "error") },
      { lightnings: [card({ status: "connecting" })] }, { lightnings: [card({ status: "error" })] }, { bitcoin: bitcoin({ status: "connecting" }) },
    ];
    for (const network of cases) expect(walletHandoffProblem(view(network), true), JSON.stringify(network)).toBe("loading");
  });

  it("a wallet open whose balances were not read yet says 0 for nothing: each kind is refused until its first read", () => {
    const unread: [string, Partial<NetworkWalletsView>][] = [
      ["Ark", { ark: ark({ read: undefined }) }], ["Bark", { bark: bark({ read: undefined }) }], ["Spark", { spark: spark({ read: undefined }) }],
      ["USDT", { usdt: usdt({ read: undefined }) }], ["Fedimint", { fedimint: { ...fedimint(0), federations: fedimint(0).federations.map((f) => ({ ...f, read: undefined })) } }],
      ["a Lightning card", { lightnings: [card({ read: undefined })] }], ["Lightning", { lightning: card({ read: undefined }) }], ["on-chain", { bitcoin: bitcoin({ read: undefined }) }],
    ];
    for (const [kind, network] of unread) expect(walletHandoffProblem(view(network), true), kind).toBe("loading");
    // The Cashu mints as a source hold nothing of their own (their ecash is counted at the mints), read or not.
    expect(walletHandoffProblem(view({ lightning: card({ read: undefined, providerId: "cashu-mint" }) }), true)).toBeNull();
  });

  it("every field of a network's wallets is one the check names: a new one is refused until it is handled", () => {
    expect(Object.keys(NETWORK_FIELDS).sort()).toEqual(Object.keys({ ...net(), ark: ark(), bark: bark(), fedimint: fedimint(0), spark: spark(), usdt: usdt(), lightning: card(), lightnings: [], bitcoin: bitcoin() } satisfies Required<NetworkWalletsView>).sort());
    const later = { ...view(), networks: { mainnet: net(), testnet: { ...net(), dogecoin: { balance: 0 } } } } as WalletView;
    expect(walletHandoffProblem(later, true)).toBe("wallet");
  });

  it("something a wallet waits for: an open invoice, ecash sent and not taken", () => {
    expect(walletHandoffProblem(view({ awaiting: [{ type: "cashu", kind: "invoice", amount: 0 }] }), true)).toBe("wallet");
    expect(walletHandoffProblem(view({}, { mints: [mint(0, { awaiting: [{ type: "cashu", kind: "sent", amount: 5 }] })] }), true)).toBe("wallet");
  });

  it("a wallet kind this build does not know is refused", () => {
    const wallets = [{ id: "w", type: "dogecoin" as unknown as "cashu", network: "testnet" as const, config: {} }];
    expect(walletHandoffProblem(view({}, {}, { wallets }), true)).toBe("wallet");
  });

  it("an amount field in a place this build does not name, anywhere in the view, is money", () => {
    const odd = view({}, {}, { setup: { step: "done", balance: 3 } as unknown as WalletView["setup"] });
    expect(walletHandoffProblem(odd, true)).toBe("wallet");
  });

  it("a payment that is not settled: pending, submitted or unknown", () => {
    for (const state of ["pending", "submitted", "unknown"] as const) expect(walletHandoffProblem(view({}, {}, { intents: [intent(state)] }), true)).toBe("payment");
  });
});
