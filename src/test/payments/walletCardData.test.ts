import { describe, expect, it } from "vitest";
import type { NetworkWalletsView, WalletView } from "@ghostly/browser/shared/types";
import { cardId, networkState, parseCardId, satsUnit, walletCard, walletCards, type WalletRail } from "../../components/walletCardData";
import { WALLET_RAILS } from "../../components/walletCardTypes";
import type { WalletNetwork, WalletState } from "../../lib/platform";
import { walletView } from "../fakeEngine";
import { arkReady, barkReady, sparkReady, bitcoinSource, lightningSource, mint, REAL_MINT, TEST_MINT, usdtReady } from "./fixtures";

// covers: wallet.deck, wallet.mode, wallet.instances.networks, wallet.fedimint.join, wallet.fedimint.mainnet-off

const cardsOf = (wallet: Partial<WalletView> = {}) => walletCards(walletView(wallet) as WalletState);
/** One wallet's card, as the wallet page and the chat's picker show it, by its id (`cashu:testnet`). */
const cardOf = (id: string, wallet: Partial<WalletView> = {}) => {
  const card = cardsOf(wallet).find((c) => c.id === id);
  if (!card) throw new Error(`no ${id} card among ${cardsOf(wallet).map((c) => c.id).join(", ") || "none"}`);
  const { id: _, rail: __, network: ___, ...shown } = card;
  return shown;
};
/** What one type's card on one network shows, even before that wallet has anything to be listed for. */
const faceOf = (rail: WalletRail, network: WalletNetwork, wallet: Partial<WalletView> = {}) => {
  const { id: _, rail: __, network: ___, ...shown } = walletCard(rail, network, networkState(walletView(wallet) as WalletState, network));
  return shown;
};
/** One network's wallets, given whole. */
const on = (patch: Partial<NetworkWalletsView> = {}): NetworkWalletsView => ({ mints: [], balance: 0, history: [], feesPaid: 0, ...patch });

describe("the cards", () => {
  it("makes no card for a wallet the profile does not have", () => {
    expect(cardsOf()).toEqual([]);
  });

  it("lists one card per wallet, in the deck's order, Mainnet before Testnet within a type", () => {
    const fed = (network: "bitcoin" | "regtest") => ({ federations: [{ id: "ab".repeat(32), name: "Fed", guardians: [], consensusVersion: "2.1", network, modules: [], joinedAt: 1, invite: "fed11qq", balance: 0, status: "ready" as const, lightning: true }], balance: 0, history: [] });
    const cards = cardsOf({ networks: {
      mainnet: on({ mints: [mint(REAL_MINT, 1)], ark: arkReady({ network: "bitcoin" }), bark: barkReady({ network: "bitcoin" }), spark: sparkReady({ network: "bitcoin" }), bitcoin: bitcoinSource(), fedimint: fed("bitcoin"), usdt: usdtReady({ chainId: 1 }), lightning: lightningSource() }),
      testnet: on({ mints: [mint(TEST_MINT, 1)], ark: arkReady(), bark: barkReady(), spark: sparkReady(), bitcoin: bitcoinSource({ mode: "testnet" }), fedimint: fed("regtest"), usdt: usdtReady(), lightning: lightningSource({ mode: "testnet" }) }),
    } });
    expect(cards.map((c) => c.id)).toEqual(WALLET_RAILS.flatMap((rail) => [`${rail}:mainnet`, `${rail}:testnet`]));
    expect(cards.map((c) => [c.rail, c.network])).toEqual(WALLET_RAILS.flatMap((rail) => [[rail, "mainnet"], [rail, "testnet"]]));
    // The website's deck puts its cards in this order (website/components/home/WalletDeck.tsx).
    expect([...new Set(cards.map((c) => c.rail))]).toEqual(WALLET_RAILS);
  });

  it("puts each wallet on the network of its own chain", () => {
    expect(cardsOf({ ark: arkReady({ network: "mutinynet" }), usdt: usdtReady({ chainId: 1 }), mints: [mint(TEST_MINT, 5)], balance: 5 }).map((c) => c.id))
      .toEqual(["cashu:testnet", "lightning:testnet", "arkade:testnet", "usdt:mainnet"]);
  });
});

describe("two wallets of one type, one on each network", () => {
  const both = {
    networks: {
      mainnet: on({ mints: [mint(REAL_MINT, 1_300)], balance: 1_300, ark: arkReady({ network: "bitcoin", balance: 42 }) }),
      testnet: on({ mints: [mint(TEST_MINT, 200)], balance: 200, ark: arkReady({ network: "mutinynet", balance: 5_000 }) }),
    },
  };

  it("show as two cards, each with its own network's balance", () => {
    expect(cardsOf(both).map((c) => c.id)).toEqual(["cashu:mainnet", "cashu:testnet", "arkade:mainnet", "arkade:testnet"]);
    expect(cardOf("cashu:mainnet", both)).toEqual({ name: "Cashu", balance: "1,300 sats", detail: "Ecash · your mints", status: "Ready", ready: true });
    expect(cardOf("cashu:testnet", both)).toEqual({ name: "Cashu", balance: "200 test sats", detail: "Ecash · test mints", status: "Ready", ready: true });
    expect(cardOf("arkade:mainnet", both)).toMatchObject({ balance: "42 sats", detail: "Arkade · Bitcoin" });
    expect(cardOf("arkade:testnet", both)).toMatchObject({ balance: "5,000 test sats", detail: "Arkade · mutinynet" });
  });

  it("never add a test sat to a real one", () => {
    const mainnet = cardsOf(both).filter((c) => c.network === "mainnet");
    expect(mainnet.map((c) => c.balance).join(" ")).not.toContain("test");
    expect(mainnet.find((c) => c.rail === "cashu")!.balance).toBe("1,300 sats");
  });
});

describe("a test wallet's amounts always say test sats, a Mainnet one's plain sats", () => {
  it("on every kind of wallet that counts sats", () => {
    const testnet = cardsOf({
      mints: [mint(TEST_MINT, 500)], balance: 500, lightning: lightningSource({ mode: "testnet", balance: 5 }), ark: arkReady({ network: "mutinynet", balance: 5_000 }),
      bark: barkReady({ network: "regtest", balance: 3_000 }), spark: sparkReady({ balance: 4_000 }), bitcoin: bitcoinSource({ mode: "testnet", balance: 7 }),
    });
    expect(testnet.map((c) => [c.id, c.balance])).toEqual([
      ["cashu:testnet", "500 test sats"], ["lightning:testnet", "5 test sats"], ["arkade:testnet", "5,000 test sats"],
      ["bark:testnet", "3,000 test sats"], ["spark:testnet", "4,000 test sats"], ["bitcoin:testnet", "7 test sats"],
    ]);
    const mainnet = cardsOf({
      mints: [mint(REAL_MINT, 500)], balance: 500, lightning: lightningSource({ balance: 5 }), ark: arkReady({ network: "bitcoin", balance: 5_000 }),
      bark: barkReady({ network: "bitcoin", balance: 3_000 }), spark: sparkReady({ network: "bitcoin", balance: 4_000 }), bitcoin: bitcoinSource({ balance: 7 }),
    });
    expect(mainnet.map((c) => [c.id, c.balance])).toEqual([
      ["cashu:mainnet", "500 sats"], ["lightning:mainnet", "5 sats"], ["arkade:mainnet", "5,000 sats"],
      ["bark:mainnet", "3,000 sats"], ["spark:mainnet", "4,000 sats"], ["bitcoin:mainnet", "7 sats"],
    ]);
  });

  it("whatever the old profile-wide mode says", () => {
    expect(cardOf("arkade:testnet", { mode: "mainnet", ark: arkReady({ network: "mutinynet", balance: 5_000 }) }).balance).toBe("5,000 test sats");
    expect(cardOf("cashu:testnet", { mode: "testnet", mints: [mint(TEST_MINT, 500)], balance: 500 }).balance).toBe("500 test sats");
  });

  it("satsUnit: the unit of a network's amounts", () => {
    expect(satsUnit("testnet")).toBe("test sats");
    expect(satsUnit("mainnet")).toBe("sats");
  });
});

describe("a card's id", () => {
  it("is its type and its network", () => {
    expect(cardId("cashu", "testnet")).toBe("cashu:testnet");
    expect(parseCardId("bark:mainnet")).toEqual({ rail: "bark", network: "mainnet" });
    expect(parseCardId(cardId("usdt", "testnet"))).toEqual({ rail: "usdt", network: "testnet" });
  });

  it("names no wallet without a known network", () => {
    expect(parseCardId("cashu")).toBeUndefined();
    expect(parseCardId("cashu:signet")).toBeUndefined();
  });
});

describe("Cashu", () => {
  it("asks to be set up without a mint", () => {
    expect(faceOf("cashu", "mainnet")).toEqual({ name: "Cashu", balance: "0 sats", detail: "Ecash · your mints", status: "Set up", ready: false });
    expect(faceOf("cashu", "testnet")).toMatchObject({ balance: "0 test sats", detail: "Ecash · test mints", status: "Set up", ready: false });
  });

  it("counts a Mainnet wallet's mints in sats", () => {
    expect(cardOf("cashu:mainnet", { mints: [mint(REAL_MINT, 1_300)], balance: 1_300 }))
      .toEqual({ name: "Cashu", balance: "1,300 sats", detail: "Ecash · your mints", status: "Ready", ready: true });
  });

  it("counts every sat of a Testnet wallet as a test sat", () => {
    expect(cardOf("cashu:testnet", { mints: [mint(TEST_MINT, 500)], balance: 500 }))
      .toEqual({ name: "Cashu", balance: "500 test sats", detail: "Ecash · test mints", status: "Ready", ready: true });
  });
});

describe("Lightning", () => {
  it("shares the Cashu balance when the mints are its source", () => {
    expect(cardOf("lightning:mainnet", { mints: [mint(REAL_MINT, 700)], balance: 700 }))
      .toEqual({ name: "Lightning", balance: "700 sats", detail: "Invoices via Cashu", status: "Shared balance", ready: true });
    expect(faceOf("lightning", "mainnet", { lightning: lightningSource({ providerId: "cashu-mint" }) })).toMatchObject({ status: "Shared balance", ready: false });
  });

  it("shows a node of its own by name, with its balance", () => {
    expect(cardOf("lightning:mainnet", { lightning: lightningSource({ alias: "My node", balance: 12_345 }) }))
      .toEqual({ name: "Lightning", balance: "12,345 sats", detail: "Via My node", status: "Ready", ready: true });
    expect(cardOf("lightning:testnet", { lightning: lightningSource({ mode: "testnet", label: "LND", balance: 5 }) })).toMatchObject({ balance: "5 test sats", detail: "Via LND" });
    expect(cardOf("lightning:mainnet", { lightning: lightningSource() })).toMatchObject({ balance: "Ready", detail: "Via cln-1" });
  });

  it.each([
    ["error", "Unavailable", "Check settings"],
    ["connecting", "Connecting…", "Connecting…"],
  ] as const)("while its node is %s, says %s", (state, balance, status) => {
    expect(cardOf("lightning:mainnet", { lightning: lightningSource({ status: state }) })).toMatchObject({ balance, status, ready: false });
  });

  it("while its node reconnects, shows the last balance it read", () => {
    expect(cardOf("lightning:mainnet", { lightning: lightningSource({ status: "connecting", balance: 21, balanceAt: 1 }) })).toMatchObject({ balance: "21 sats", status: "Connecting…", ready: false });
  });
});

describe("Ark", () => {
  it("is ready once it has an address, in test sats off Bitcoin", () => {
    expect(cardOf("arkade:testnet", { ark: arkReady({ network: "mutinynet", balance: 5_000 }) }))
      .toEqual({ name: "Ark", balance: "5,000 test sats", detail: "Arkade · mutinynet", status: "Ready", ready: true });
    expect(cardOf("arkade:mainnet", { ark: arkReady({ network: "bitcoin", balance: 42 }) })).toMatchObject({ balance: "42 sats", detail: "Arkade · Bitcoin" });
  });

  it.each([
    ["not set up", undefined, "Connecting…"],
    ["waiting for its provider's address", arkReady({ address: undefined, automatic: true }), "Connecting…"],
    ["sealed with a password", arkReady({ locked: true, automatic: false }), "Locked"],
  ])("is not ready while %s", (_, ark, balance) => {
    expect(faceOf("arkade", "testnet", { ark })).toMatchObject({ balance, status: "Experimental", ready: false });
  });
});

describe("Bark", () => {
  it("is ready once it has an address", () => {
    expect(cardOf("bark:testnet", { bark: barkReady({ network: "regtest", balance: 3_000 }) }))
      .toEqual({ name: "Bark", balance: "3,000 test sats", detail: "Second's Ark · regtest", status: "Ready", ready: true });
    expect(cardOf("bark:mainnet", { bark: barkReady({ network: "bitcoin", balance: 3 }) })).toMatchObject({ balance: "3 sats", detail: "Second's Ark · Bitcoin" });
  });

  it("says it is not on Mainnet yet where it is unavailable", () => {
    expect(faceOf("bark", "testnet", { bark: { configured: false, locked: false, balance: 0, unavailable: "Mainnet" } }))
      .toMatchObject({ balance: "Testnet only", status: "Not on Mainnet yet", detail: "Second's Ark · signet", ready: false });
  });
});

describe("Spark", () => {
  it("is ready once it has its Spark address, and says where it runs", () => {
    expect(cardOf("spark:testnet", { spark: sparkReady({ balance: 4_000 }) }))
      .toEqual({ name: "Spark", balance: "4,000 test sats", detail: "Spark · regtest", status: "Ready", ready: true });
    expect(cardOf("spark:testnet", { spark: sparkReady({ address: undefined }) })).toMatchObject({ balance: "Connecting…", ready: false });
  });

  it("on Mainnet: asks for a Breez API key first, then says it is real bitcoin", () => {
    expect(faceOf("spark", "mainnet", { spark: { configured: false, locked: true, balance: 0, network: "bitcoin", needsKey: true, unavailable: "key" } }))
      .toMatchObject({ balance: "Needs a key", status: "Set up", detail: "Spark · Bitcoin", ready: false });
    expect(cardOf("spark:mainnet", { spark: sparkReady({ network: "bitcoin", balance: 21 }) })).toMatchObject({ balance: "21 sats", status: "Real bitcoin", detail: "Spark · Bitcoin", ready: true });
  });
});

describe("Bitcoin on-chain", () => {
  it("asks for a source until one is set up", () => {
    expect(faceOf("bitcoin", "mainnet")).toEqual({ name: "Bitcoin", balance: "No source", detail: "On-chain", status: "Set up", ready: false });
    expect(faceOf("bitcoin", "mainnet", { bitcoin: bitcoinSource({ status: "none", providerId: undefined }) })).toMatchObject({ status: "Set up" });
  });

  it("shows its source and balance once ready", () => {
    expect(cardOf("bitcoin:mainnet", { bitcoin: bitcoinSource({ alias: "Home node", balance: 10_000 }) }))
      .toEqual({ name: "Bitcoin", balance: "10,000 sats", detail: "On-chain · Home node", status: "Ready", ready: true });
    expect(cardOf("bitcoin:testnet", { bitcoin: bitcoinSource({ mode: "testnet", balance: 7 }) })).toMatchObject({ balance: "7 test sats", detail: "On-chain · bdk" });
  });

  it.each([
    ["error", "Unavailable", "Check settings"],
    ["connecting", "Connecting…", "Connecting…"],
  ] as const)("while its source is %s, says %s", (state, balance, status) => {
    expect(cardOf("bitcoin:mainnet", { bitcoin: bitcoinSource({ status: state, balance: undefined }) })).toMatchObject({ balance, status, ready: false });
  });

  it("while it reconnects, shows the last balance it read; once unavailable, says so", () => {
    expect(cardOf("bitcoin:testnet", { bitcoin: bitcoinSource({ mode: "testnet", status: "connecting", balance: 1_234, balanceAt: 1, failures: 2 }) }))
      .toMatchObject({ balance: "1,234 test sats", status: "Connecting…", ready: false });
    expect(cardOf("bitcoin:mainnet", { bitcoin: bitcoinSource({ status: "error", balance: 1_234, balanceAt: 1 }) })).toMatchObject({ balance: "Unavailable", status: "Check settings" });
  });
});

describe("USDT", () => {
  it.each([
    [11155111, "usdt:testnet", "5 TEST-USDT", "Sepolia · test token"],
    [31337, "usdt:testnet", "5 TEST-USDT", "EVM local · test token"],
    [1, "usdt:mainnet", "5 USDT", "Ethereum · via WDK"],
  ])("on chain %i is %s and shows %s", (chainId, id, balance, detail) => {
    expect(cardOf(id, { usdt: usdtReady({ chainId, balance: "5000000" }) })).toEqual({ name: "USDT", balance, detail, status: "Ready", ready: true });
  });

  it("shows fractions of a token", () => {
    expect(cardOf("usdt:testnet", { usdt: usdtReady({ balance: "1250000" }) }).balance).toBe("1.25 TEST-USDT");
  });

  it("is locked while sealed with a password, and connecting before that", () => {
    expect(cardOf("usdt:testnet", { usdt: usdtReady({ locked: true, automatic: false }) })).toMatchObject({ balance: "Locked", status: "Experimental", ready: false });
    expect(faceOf("usdt", "testnet")).toMatchObject({ balance: "Connecting…", detail: "Sepolia · test token", ready: false });
  });
});

describe("Fedimint", () => {
  const federation = (over: Record<string, unknown> = {}) => ({ id: "ab".repeat(32), name: "Ghostly regtest", guardians: [{ name: "g0", url: "ws://127.0.0.1:47095" }], consensusVersion: "2.1", network: "regtest" as const,
    modules: ["ln", "mint", "wallet"], joinedAt: 1, invite: "fed11qq", balance: 0, status: "ready" as const, lightning: true, ...over });
  it("says it is Testnet only on Mainnet", () => {
    expect(faceOf("fedimint", "mainnet", { fedimint: { unavailable: "not yet", federations: [], balance: 0, history: [] } }))
      .toEqual({ name: "Fedimint", balance: "Testnet only", detail: "Federation ecash", status: "Not on Mainnet yet", ready: false });
  });
  it("asks for a federation, and joins none by itself", () => {
    const fedimint = { federations: [], balance: 0, history: [] };
    expect(cardsOf({ fedimint }).map((c) => c.id)).toEqual([]);
    expect(faceOf("fedimint", "testnet", { mode: "testnet", fedimint })).toMatchObject({ balance: "No federation", status: "Set up", ready: false });
  });
  it("shows the balance of its federations, named, once one is connected", () => {
    expect(cardOf("fedimint:testnet", { fedimint: { federations: [federation({ balance: 1_200 })], balance: 1_200, history: [] } }))
      .toEqual({ name: "Fedimint", balance: "1,200 test sats", detail: "Ghostly regtest", status: "Ready", ready: true });
    expect(cardOf("fedimint:testnet", { fedimint: { federations: [federation({ balance: 5 }), federation({ id: "cd".repeat(32), balance: 7 })], balance: 12, history: [] } }))
      .toMatchObject({ balance: "12 test sats", detail: "2 federations" });
    expect(cardOf("fedimint:testnet", { fedimint: { federations: [federation({ status: "connecting" })], balance: 0, history: [] } })).toMatchObject({ balance: "Connecting…", ready: false });
    expect(cardOf("fedimint:testnet", { fedimint: { federations: [federation({ status: "error" })], balance: 0, history: [] } })).toMatchObject({ balance: "Unavailable", ready: false });
  });
});
