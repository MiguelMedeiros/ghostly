import { describe, expect, it } from "vitest";
import { BLOCK_MS, EXPIRY_REFUSE_MS, NETWORK_FIELDS, afterStop, planHandoffWallets, type HandoffWalletFacts } from "../src/devices/handoffWallets";
import type { MintView, NetworkWalletsView, WalletView } from "../src/shared/types";
import type { ArkWalletView } from "../src/engine/paymentAdapters/arkWallet";
import type { BarkWalletView } from "../src/engine/paymentAdapters/barkWallet";
import type { FedimintWalletView } from "../src/engine/paymentAdapters/fedimintWallet";
import type { SparkWalletView } from "../src/engine/paymentAdapters/sparkWallet";
import type { UsdtWalletView } from "../src/engine/paymentAdapters/usdtWallet";
import type { LightningCardView } from "../src/engine/paymentAdapters/providers/lightningCards";
import type { BitcoinView } from "../src/engine/paymentAdapters/providers/bitcoinService";
import type { PaymentReview } from "@ghostly/core";
// covers: devices.handoff.wallets

/*
 * Wallets in a handoff (WISP 06 § Wallets, phase 1): each wallet moves, stays on its home device, or keeps the profile
 * here, from the engine's own view types. Testnet money moves; Mainnet money of a type that moves keeps the profile
 * here; a wallet that stays home is marked with its home and its coins' expiry; anything this build cannot judge is
 * refused, as before.
 */

const NOW = 1_800_000_000_000;
const DESKTOP = "D".repeat(43), PHONE = "P".repeat(43), TABLET = "T".repeat(43);
const PINS = { ark: "0.4.76", bark: "0.25.0", breez: "0.26.0", fedimint: "eea6a3c98909" };

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
const card = (extra: Partial<LightningCardView> = {}): LightningCardView => ({ mode: "testnet", status: "ready", read: true, offered: [], recent: [], card: "c1", name: "Card", receive: true, providerId: "nwc", ...extra });
const bitcoin = (extra: Partial<BitcoinView> = {}): BitcoinView => ({ mode: "testnet", status: "ready", read: true, offered: [], history: [], providerId: "bdk", ...extra });
const intent = (state: PaymentReview["state"], method = "cashu", network = "testnet"): PaymentReview => ({ state, method, network } as Partial<PaymentReview> as PaymentReview);

const facts = (v: WalletView, extra: Partial<HandoffWalletFacts> = {}): HandoffWalletFacts => ({
  view: v, read: true, ownKey: DESKTOP, ownPins: PINS, taker: { key: PHONE, kind: "web", pins: PINS }, homes: {}, now: NOW, ...extra,
});
const plan = (v: WalletView, extra: Partial<HandoffWalletFacts> = {}) => planHandoffWallets(facts(v, extra));
const why = (v: WalletView, extra: Partial<HandoffWalletFacts> = {}) => plan(v, extra).refusal?.why ?? null;
const route = (v: WalletView, id: string, extra: Partial<HandoffWalletFacts> = {}) => plan(v, extra).wallets.find((w) => w.id === id);

describe("wallets that move", () => {
  it("Testnet money in every wallet that moves: it moves, and nothing keeps the profile here", () => {
    const v = view({}, {
      mints: [mint(2100)], balance: 2100, spark: spark({ balance: 500 }), bitcoin: bitcoin({ balance: 10_000, unconfirmed: 5 }),
      lightnings: [card({ card: "nwc", balance: 7 }), card({ card: "cln", providerId: "core-lightning", balance: 8 }), card({ card: "lnd", providerId: "lnd", balance: 9 }), card({ card: "breez", providerId: "breez", balance: 3 })],
    });
    const p = plan(v);
    expect(p.refusal).toBeNull();
    expect(p.wallets.map((w) => [w.id, w.route, !!w.breez])).toEqual([
      ["cashu:testnet", "moves", false], ["spark:testnet", "moves", true],
      ["lightning:testnet:nwc", "moves", false], ["lightning:testnet:cln", "moves", false], ["lightning:testnet:lnd", "moves", false], ["lightning:testnet:breez", "moves", true],
      ["bitcoin:testnet", "moves", false],
    ]);
  });

  it("what a Testnet wallet waits for moves with it: an open invoice, ecash sent and not taken, a melt, a payment at rest", () => {
    const v = view({}, { mints: [mint(0, { awaiting: [{ type: "cashu", kind: "sent", amount: 5 }] })], awaiting: [{ type: "cashu", kind: "invoice", amount: 0 }] },
      { intents: [intent("submitted"), intent("unknown", "spark", "regtest")] });
    expect(why(v)).toBeNull();
    expect(route(v, "cashu:testnet")?.route).toBe("moves");
  });

  it("Mainnet money in a wallet that moves keeps the profile here: Testnet first", () => {
    const cases: [string, Partial<NetworkWalletsView>][] = [
      ["ecash", { mints: [mint(21)], balance: 21 }], ["ecash on its way", { mints: [mint(0, { awaiting: [{ type: "cashu", kind: "sent", amount: 5 }] })] }],
      ["an invoice of the mints", { mints: [mint(0)], awaiting: [{ type: "cashu", kind: "invoice", amount: 100 }] }],
      ["Spark", { spark: spark({ balance: 1 }) }], ["an NWC card", { lightnings: [card({ mode: "mainnet", balance: 2 })] }],
      ["an LND card", { lightnings: [card({ mode: "mainnet", providerId: "lnd", balance: 3 })] }], ["on-chain", { bitcoin: bitcoin({ mode: "mainnet", unconfirmed: 4 }) }],
    ];
    for (const [name, mainnet] of cases) expect(plan(view(mainnet)).refusal, name).toMatchObject({ why: "mainnet", network: "mainnet" });
    // A Mainnet payment at rest of a type that moves, too.
    expect(why(view({ mints: [mint(0)] }, {}, { intents: [intent("submitted", "cashu", "bitcoin")] }))).toBe("mainnet");
  });

  it("an empty Mainnet wallet of a type that moves moves as a record: the default Mainnet Cashu wallet", () => {
    const v = view({ mints: [mint(0)], lightnings: [card({ card: "cashu", providerId: "cashu-mint", mode: "mainnet", read: undefined })] });
    expect(why(v)).toBeNull();
    expect(route(v, "cashu:mainnet")?.route).toBe("moves");
    expect(route(v, "lightning:mainnet:cashu")?.route).toBe("moves");
  });

  it("a wallet that moves and cannot be read now is not known to be what it seems: locked, connecting, in error, not read yet", () => {
    const cases: Partial<NetworkWalletsView>[] = [
      { spark: spark({ locked: true }) }, { spark: spark({ read: undefined }) }, { spark: spark({ error: "Connecting to Spark…" }) },
      { lightnings: [card({ status: "connecting" })] }, { lightnings: [card({ status: "error" })] }, { lightnings: [card({ read: undefined })] },
      { bitcoin: bitcoin({ status: "connecting" }) }, { bitcoin: bitcoin({ read: undefined }) },
    ];
    for (const network of cases) {
      expect(why(view({}, network)), `testnet ${JSON.stringify(network)}`).toBe("loading");
      expect(why(view(network)), `mainnet ${JSON.stringify(network)}`).toBe("loading");
    }
  });

  it("LND with a pinned certificate stays home, except when a Desktop takes the profile", () => {
    const pinned = view({}, { lightnings: [card({ card: "lnd", providerId: "lnd", balance: 50 })] });
    const lnd = { pinned: new Set(["lightning:testnet:lnd"]) };
    expect(route(pinned, "lightning:testnet:lnd", lnd)).toMatchObject({ route: "home", home: { key: DESKTOP } });
    expect(route(pinned, "lightning:testnet:lnd")?.route, "no certificate").toBe("moves");
    expect(route(pinned, "lightning:testnet:lnd", { ...lnd, taker: { key: PHONE, kind: "desktop", pins: PINS } })?.route).toBe("moves");
    // Not known yet whose the taker is (a push asked before its hello): it stays home.
    expect(route(pinned, "lightning:testnet:lnd", { ...lnd, taker: undefined })?.route).toBe("home");
  });

  it("a wallet whose SDK pin differs on the taker stays home in that handoff", () => {
    const v = view({}, { spark: spark({ balance: 5 }), lightnings: [card({ card: "breez", providerId: "breez" })] });
    const older = { key: PHONE, kind: "web" as const, pins: { ...PINS, breez: "0.25.0" } };
    expect(route(v, "spark:testnet", { taker: older })).toMatchObject({ route: "home", home: { key: DESKTOP } });
    expect(route(v, "spark:testnet", { taker: older })?.breez).toBeUndefined();
    expect(route(v, "lightning:testnet:breez", { taker: older })?.route).toBe("home");
  });

  it("the browser's own wallet has nothing to move, whatever it holds", () => {
    const v = view({ lightnings: [card({ card: "w", providerId: "webln", mode: "mainnet", balance: 1000 })] });
    expect(why(v)).toBeNull();
    expect(route(v, "lightning:mainnet:w")?.route).toBe("none");
  });
});

describe("wallets that stay home", () => {
  it("Ark, Bark, Fedimint, USDT and Bitcoin Core stay on this device, with their money, on either network", () => {
    for (const network of ["mainnet", "testnet"] as const) {
      const wallets: Partial<NetworkWalletsView> = { ark: ark({ balance: 10, expiresAt: NOW + 20 * 86_400_000 }), bark: bark({ balance: 20, expiry: { blocksLeft: 4000 } }), fedimint: fedimint(30), usdt: usdt({ balance: "40", gasBalance: "1" }), bitcoin: bitcoin({ providerId: "bitcoind", balance: 50 }) };
      const v = network === "mainnet" ? view(wallets) : view({}, wallets);
      const p = plan(v);
      expect(p.refusal, network).toBeNull();
      expect(p.wallets.map((w) => [w.id, w.route, w.home?.key])).toEqual(["arkade", "bark", "fedimint", "usdt", "bitcoin"].map((type) => [`${type}:${network}`, "home", DESKTOP]));
      expect(route(v, `arkade:${network}`)?.home?.expiresAt).toBe(NOW + 20 * 86_400_000);
      expect(route(v, `bark:${network}`)?.home?.expiresAt).toBe(NOW + 4000 * BLOCK_MS);
    }
  });

  it("a Mainnet payment at rest of a wallet that stays home stays with it", () => {
    expect(why(view({ usdt: usdt({ balance: "5" }) }, {}, { intents: [intent("submitted", "usdt", "ethereum")] }))).toBeNull();
  });

  it("coins that expire in under 3 days refuse the handoff, with no override, and say when", () => {
    const soon = NOW + EXPIRY_REFUSE_MS - 60_000;
    expect(plan(view({}, { ark: ark({ balance: 10, expiresAt: soon }) })).refusal).toMatchObject({ why: "expiry", wallet: "arkade", expiresAt: soon });
    expect(plan(view({ bark: bark({ balance: 10, expiry: { blocksLeft: 400 } }) })).refusal).toMatchObject({ why: "expiry", wallet: "bark", network: "mainnet", expiresAt: NOW + 400 * BLOCK_MS });
    expect(why(view({ bark: bark({ pending: 3, expiry: { blocksLeft: 433 } }) }))).toBeNull();
    // No coins, nothing to expire.
    expect(why(view({ bark: bark({ expiry: { lifetime: 4032 } }), ark: ark() }))).toBeNull();
  });

  it("coins kept here whose wallet cannot be read: their expiry is not known", () => {
    expect(why(view({ bark: bark({ balance: 5, read: undefined }) }))).toBe("loading");
    expect(why(view({ ark: ark({ balance: 5, locked: true }) }))).toBe("loading");
    // A wallet that stays home holding no coins that expire is not read for the handoff.
    expect(why(view({ usdt: usdt({ locked: true }), fedimint: fedimint(0, "connecting") }))).toBeNull();
  });

  it("a wallet at home on another device stays there, is never read here, and its carried expiry is enforced", () => {
    // The profile is on the phone; the desktop is the Bark wallet's home. The phone never opened it: locked and unread.
    const v = view({ bark: bark({ locked: true, read: undefined }), spark: spark({ locked: true, read: undefined }) });
    const homes = { "bark:mainnet": { key: DESKTOP, expiresAt: NOW + 10 * 86_400_000 }, "spark:mainnet": { key: DESKTOP } };
    const onPhone = { ownKey: PHONE, homes, taker: { key: TABLET, kind: "web" as const, pins: PINS } };
    const p = plan(v, onPhone);
    expect(p.refusal).toBeNull();
    expect(p.wallets).toEqual([
      { id: "bark:mainnet", type: "bark", network: "mainnet", route: "home", home: homes["bark:mainnet"] },
      // A kind that moves now, homed elsewhere: it stays where its database is until it moves from there.
      { id: "spark:mainnet", type: "spark", network: "mainnet", route: "home", home: homes["spark:mainnet"] },
    ]);
    // Under 3 days to the carried expiry: refused to the tablet, allowed home.
    const late = { ...homes, "bark:mainnet": { key: DESKTOP, expiresAt: NOW + 86_400_000 } };
    expect(plan(v, { ...onPhone, homes: late }).refusal).toMatchObject({ why: "expiry", wallet: "bark", expiresAt: NOW + 86_400_000 });
    expect(why(v, { ...onPhone, homes: late, taker: { key: DESKTOP, kind: "desktop", pins: PINS } })).toBeNull();
  });

  it("a wallet at home on this device is this device's again, whatever an older mark said", () => {
    const v = view({}, { usdt: usdt() });
    expect(route(v, "usdt:testnet", { homes: { "usdt:testnet": { key: DESKTOP } } })?.home).toEqual({ key: DESKTOP });
  });
});

describe("in flight", () => {
  it("a payment call that has not returned, or a Cashu swap in its lock: refused, as a payment", () => {
    expect(why(view(), { executing: true })).toBe("payment");
  });

  it("a review not approved is cancelled at quiesce: allowed before, refused if one is left after the stop", () => {
    const v = view({}, {}, { intents: [intent("pending")] });
    expect(why(v)).toBeNull();
    expect(why(v, { final: true })).toBe("payment");
  });

  it("what can be judged is said before a payment still going through", () => {
    expect(why(view({ mints: [mint(5)], balance: 5 }), { executing: true })).toBe("mainnet");
  });
});

describe("the strict net under it all", () => {
  it("before the wallets were read once: not known, so refused", () => {
    expect(why(view(), { read: false })).toBe("loading");
  });

  it("a wallet kind, a source or a payment method this build does not know is refused", () => {
    expect(why(view({}, {}, { wallets: [{ id: "w", type: "dogecoin" as unknown as "cashu", network: "testnet", config: {} }] }))).toBe("wallet");
    expect(why(view({}, { lightnings: [card({ providerId: "lightning-of-tomorrow" })] }))).toBe("wallet");
    expect(why(view({}, { bitcoin: bitcoin({ providerId: "electrum" }) }))).toBe("wallet");
    expect(why(view({}, {}, { intents: [intent("submitted", "dogecoin")] }))).toBe("wallet");
  });

  it("every field of a network's wallets is one the check names: a new one is refused until it is handled", () => {
    expect(Object.keys(NETWORK_FIELDS).sort()).toEqual(Object.keys({ ...net(), ark: ark(), bark: bark(), fedimint: fedimint(0), spark: spark(), usdt: usdt(), lightning: card(), lightnings: [], bitcoin: bitcoin() } satisfies Required<NetworkWalletsView>).sort());
    const later = { ...view(), networks: { mainnet: net(), testnet: { ...net(), dogecoin: { balance: 0 } } } } as WalletView;
    expect(why(later)).toBe("wallet");
    const elsewhere = { ...view(), networks: { mainnet: net(), testnet: net(), signet: net() } } as unknown as WalletView;
    expect(why(elsewhere)).toBe("wallet");
  });

  it("an amount field in a place this build does not name, anywhere in the view, is money", () => {
    const odd = view({}, {}, { setup: { step: "done", balance: 3 } as unknown as WalletView["setup"] });
    expect(why(odd)).toBe("wallet");
  });
});

describe("after the stop", () => {
  it("SDK wallets as they were before the stop closed them, the profile's own database as it is now", () => {
    const before = view({}, { spark: spark({ balance: 5 }), lightnings: [card({ card: "cashu", providerId: "cashu-mint" }), card({ card: "nwc" })], mints: [mint(10)], balance: 10, awaiting: [{ type: "lightning", kind: "invoice", amount: 1, card: "nwc" }] });
    const after = view({ mints: [mint(1)], balance: 1 }, { spark: spark({ locked: true, read: undefined }), lightnings: [card({ card: "cashu", providerId: "cashu-mint" }), card({ card: "nwc", status: "connecting" })], mints: [mint(12)], balance: 12, awaiting: [{ type: "lightning", kind: "invoice", amount: 2, card: "cashu" }] }, { intents: [intent("pending")] });
    const merged = afterStop(before, after);
    expect(merged.networks!.testnet.spark).toEqual(spark({ balance: 5 }));
    expect(merged.networks!.testnet.lightnings![1].status).toBe("ready");
    expect(merged.networks!.testnet.balance).toBe(12);
    expect(merged.networks!.testnet.awaiting).toEqual([{ type: "lightning", kind: "invoice", amount: 2, card: "cashu" }, { type: "lightning", kind: "invoice", amount: 1, card: "nwc" }]);
    // Mainnet ecash that arrived between the last look and the stop is seen.
    expect(planHandoffWallets(facts(merged, { final: true })).refusal?.why).toBe("mainnet");
    expect(merged.intents).toEqual([intent("pending")]);
  });
});
