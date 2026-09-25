import { describe, expect, it } from "vitest";
import type { WalletView } from "@ghostly/browser/shared/types";
import { TEST_MINTS } from "@ghostly/browser/shared/mints";
import { pageUnit, walletCards, type WalletRail } from "../../components/walletCardData";
import { walletView } from "../fakeEngine";
import { arkReady, barkReady, sparkReady, bitcoinSource, lightningSource, mint, REAL_MINT, TEST_MINT, usdtReady } from "./fixtures";

// covers: wallet.deck, wallet.mode, wallet.fedimint.join, wallet.fedimint.mainnet-off

/** One card, as the chat's picker shows it (no Testnet badge beside it: a test sat says so). */
const cardOf = (rail: WalletRail, wallet: Partial<WalletView> = {}) => {
  const { id: _, ...shown } = walletCards(walletView(wallet), TEST_MINTS).find((c) => c.id === rail)!;
  return shown;
};
/** The same card on the wallet page, under the Testnet badge and banner. */
const pageCardOf = (rail: WalletRail, wallet: Partial<WalletView> = {}) => walletCards(walletView(wallet), TEST_MINTS, { badged: true }).find((c) => c.id === rail)!;

it("lists every wallet, in the deck's order", () => {
  expect(walletCards(walletView(), TEST_MINTS).map((c) => c.id)).toEqual(["cashu", "lightning", "arkade", "bark", "spark", "bitcoin", "fedimint", "usdt"]);
});

describe("Cashu", () => {
  it("asks to be set up without a mint", () => {
    expect(cardOf("cashu")).toEqual({ name: "Cashu", balance: "0 sats", detail: "Ecash · your mints", status: "Set up", ready: false });
  });

  it("counts only real sats on Mainnet, and says how many test sats wait aside", () => {
    expect(cardOf("cashu", { mints: [mint(REAL_MINT, 1_300), mint(TEST_MINT, 200)], balance: 1_500 }))
      .toEqual({ name: "Cashu", balance: "1,300 sats", detail: "+200 test sats", status: "Ready", ready: true });
  });

  it("counts every sat as a test sat in Testnet", () => {
    expect(cardOf("cashu", { mode: "testnet", mints: [mint(TEST_MINT, 500)], balance: 500 }))
      .toMatchObject({ balance: "500 test sats", detail: "Ecash · test mints", status: "Ready" });
  });
});

describe("Lightning", () => {
  it("shares the Cashu balance when the mints are its source", () => {
    expect(cardOf("lightning", { mints: [mint(REAL_MINT, 700)], balance: 700 }))
      .toEqual({ name: "Lightning", balance: "700 sats", detail: "Invoices via Cashu", status: "Shared balance", ready: true });
    expect(cardOf("lightning", { lightning: lightningSource({ providerId: "cashu-mint" }) })).toMatchObject({ status: "Shared balance", ready: false });
  });

  it("shows a node of its own by name, with its balance", () => {
    expect(cardOf("lightning", { lightning: lightningSource({ alias: "My node", balance: 12_345 }) }))
      .toEqual({ name: "Lightning", balance: "12,345 sats", detail: "Via My node", status: "Ready", ready: true });
    expect(cardOf("lightning", { mode: "testnet", lightning: lightningSource({ label: "LND", balance: 5 }) })).toMatchObject({ balance: "5 test sats", detail: "Via LND" });
    expect(cardOf("lightning", { lightning: lightningSource() })).toMatchObject({ balance: "Ready", detail: "Via cln-1" });
  });

  it.each([
    ["error", "Unavailable", "Check settings"],
    ["connecting", "Connecting…", "Connecting…"],
  ] as const)("while its node is %s, says %s", (state, balance, status) => {
    expect(cardOf("lightning", { lightning: lightningSource({ status: state }) })).toMatchObject({ balance, status, ready: false });
  });

  it("while its node reconnects, shows the last balance it read", () => {
    expect(cardOf("lightning", { lightning: lightningSource({ status: "connecting", balance: 21, balanceAt: 1 }) })).toMatchObject({ balance: "21 sats", status: "Connecting…", ready: false });
  });
});

describe("Ark", () => {
  it("is ready once it has an address, in test sats off Bitcoin", () => {
    expect(cardOf("arkade", { ark: arkReady({ network: "mutinynet", balance: 5_000 }) }))
      .toEqual({ name: "Ark", balance: "5,000 test sats", detail: "Arkade · mutinynet", status: "Ready", ready: true });
    expect(cardOf("arkade", { ark: arkReady({ network: "bitcoin", balance: 42 }) })).toMatchObject({ balance: "42 sats", detail: "Arkade · Bitcoin" });
  });

  it.each([
    ["not set up", undefined, "Connecting…"],
    ["waiting for its provider's address", arkReady({ address: undefined, automatic: true }), "Connecting…"],
    ["sealed with a password", arkReady({ locked: true, automatic: false }), "Locked"],
  ])("is not ready while %s", (_, ark, balance) => {
    expect(cardOf("arkade", { ark })).toMatchObject({ balance, status: "Experimental", ready: false });
  });
});

describe("Bark", () => {
  it("is ready once it has an address", () => {
    expect(cardOf("bark", { bark: barkReady({ network: "regtest", balance: 3_000 }) }))
      .toEqual({ name: "Bark", balance: "3,000 test sats", detail: "Second's Ark · regtest", status: "Ready", ready: true });
    expect(cardOf("bark", { bark: barkReady({ network: "bitcoin", balance: 3 }) })).toMatchObject({ balance: "3 sats", detail: "Second's Ark · Bitcoin" });
  });

  it("says it is not on Mainnet yet where it is unavailable", () => {
    expect(cardOf("bark", { bark: { configured: false, locked: false, balance: 0, unavailable: "Mainnet" } }))
      .toMatchObject({ balance: "Testnet only", status: "Not on Mainnet yet", detail: "Second's Ark · signet", ready: false });
  });
});

describe("Spark", () => {
  it("is ready once it has its Spark address, and says where it runs", () => {
    expect(cardOf("spark", { spark: sparkReady({ balance: 4_000 }) }))
      .toEqual({ name: "Spark", balance: "4,000 test sats", detail: "Spark · regtest", status: "Ready", ready: true });
    expect(cardOf("spark", { spark: sparkReady({ address: undefined }) })).toMatchObject({ balance: "Connecting…", ready: false });
  });

  it("on Mainnet: asks for a Breez API key first, then says it is real bitcoin", () => {
    expect(cardOf("spark", { spark: { configured: false, locked: true, balance: 0, network: "bitcoin", needsKey: true, unavailable: "key" } }))
      .toMatchObject({ balance: "Needs a key", status: "Set up", detail: "Spark · Bitcoin", ready: false });
    expect(cardOf("spark", { spark: sparkReady({ network: "bitcoin", balance: 21 }) })).toMatchObject({ balance: "21 sats", status: "Real bitcoin", detail: "Spark · Bitcoin", ready: true });
  });

  it("counts plain sats under the Testnet badge, and test sats in Mainnet", () => {
    expect(pageCardOf("spark", { mode: "testnet", spark: sparkReady({ balance: 4_000 }) }).balance).toBe("4,000 sats");
    expect(pageCardOf("spark", { spark: sparkReady({ balance: 4_000 }) }).balance).toBe("4,000 test sats");
  });
});

describe("Bitcoin on-chain", () => {
  it("asks for a source until one is set up", () => {
    expect(cardOf("bitcoin")).toEqual({ name: "Bitcoin", balance: "No source", detail: "On-chain", status: "Set up", ready: false });
    expect(cardOf("bitcoin", { bitcoin: bitcoinSource({ status: "none", providerId: undefined }) })).toMatchObject({ status: "Set up" });
  });

  it("shows its source and balance once ready", () => {
    expect(cardOf("bitcoin", { bitcoin: bitcoinSource({ alias: "Home node", balance: 10_000 }) }))
      .toEqual({ name: "Bitcoin", balance: "10,000 sats", detail: "On-chain · Home node", status: "Ready", ready: true });
    expect(cardOf("bitcoin", { mode: "testnet", bitcoin: bitcoinSource({ balance: 7 }) })).toMatchObject({ balance: "7 test sats", detail: "On-chain · bdk" });
  });

  it.each([
    ["error", "Unavailable", "Check settings"],
    ["connecting", "Connecting…", "Connecting…"],
  ] as const)("while its source is %s, says %s", (state, balance, status) => {
    expect(cardOf("bitcoin", { bitcoin: bitcoinSource({ status: state, balance: undefined }) })).toMatchObject({ balance, status, ready: false });
  });

  it("while it reconnects, shows the last balance it read; once unavailable, says so", () => {
    expect(cardOf("bitcoin", { mode: "testnet", bitcoin: bitcoinSource({ status: "connecting", balance: 1_234, balanceAt: 1, failures: 2 }) }))
      .toMatchObject({ balance: "1,234 test sats", status: "Connecting…", ready: false });
    expect(cardOf("bitcoin", { bitcoin: bitcoinSource({ status: "error", balance: 1_234, balanceAt: 1 }) })).toMatchObject({ balance: "Unavailable", status: "Check settings" });
  });
});

describe("USDT", () => {
  it.each([
    [11155111, "5 TEST-USDT", "Sepolia · test token"],
    [31337, "5 TEST-USDT", "EVM local · test token"],
    [1, "5 USDT", "Ethereum · via WDK"],
  ])("on chain %i shows %s", (chainId, balance, detail) => {
    expect(cardOf("usdt", { usdt: usdtReady({ chainId, balance: "5000000" }) })).toEqual({ name: "USDT", balance, detail, status: "Ready", ready: true });
  });

  it("shows fractions of a token", () => {
    expect(cardOf("usdt", { usdt: usdtReady({ balance: "1250000" }) }).balance).toBe("1.25 TEST-USDT");
  });

  it("is locked while sealed with a password, and connecting before that", () => {
    expect(cardOf("usdt", { usdt: usdtReady({ locked: true, automatic: false }) })).toMatchObject({ balance: "Locked", status: "Experimental", ready: false });
    expect(cardOf("usdt")).toMatchObject({ balance: "Connecting…", ready: false });
  });
});

describe("on the wallet page, under the Testnet badge", () => {
  it("counts plain sats in Testnet: the badge and the banner already say what they are", () => {
    expect(pageCardOf("cashu", { mode: "testnet", mints: [mint(TEST_MINT, 500)], balance: 500 })).toMatchObject({ balance: "500 sats", detail: "Ecash · test mints" });
    expect(pageCardOf("lightning", { mode: "testnet", lightning: lightningSource({ label: "LND", balance: 5 }) }).balance).toBe("5 sats");
    expect(pageCardOf("arkade", { mode: "testnet", ark: arkReady({ network: "mutinynet", balance: 5_000 }) }).balance).toBe("5,000 sats");
    expect(pageCardOf("bark", { mode: "testnet", bark: barkReady({ network: "regtest", balance: 3_000 }) }).balance).toBe("3,000 sats");
    expect(pageCardOf("bitcoin", { mode: "testnet", bitcoin: bitcoinSource({ balance: 7 }) }).balance).toBe("7 sats");
    expect(walletCards(walletView({ mode: "testnet", mints: [mint(TEST_MINT, 500)], balance: 500 }), TEST_MINTS, { badged: true }).map((c) => c.balance).join(" ")).not.toContain("test sats");
  });

  it("still says test sats in Mainnet, where a wallet on a test network stands out", () => {
    expect(pageCardOf("arkade", { ark: arkReady({ network: "mutinynet", balance: 5_000 }) }).balance).toBe("5,000 test sats");
    expect(pageCardOf("bark", { bark: barkReady({ network: "regtest", balance: 3_000 }) }).balance).toBe("3,000 test sats");
    expect(pageCardOf("cashu", { mints: [mint(REAL_MINT, 1_300), mint(TEST_MINT, 200)], balance: 1_500 })).toMatchObject({ balance: "1,300 sats", detail: "+200 test sats" });
  });

  it("the chat's cards say test sats either way: there is no badge beside a chat", () => {
    expect(cardOf("cashu", { mode: "testnet", mints: [mint(TEST_MINT, 500)], balance: 500 }).balance).toBe("500 test sats");
    expect(cardOf("arkade", { mode: "testnet", ark: arkReady({ network: "mutinynet", balance: 5_000 }) }).balance).toBe("5,000 test sats");
  });

  it("pageUnit: the unit of a wallet panel's balance", () => {
    expect(pageUnit({ mode: "testnet" }, true)).toBe("sats");
    expect(pageUnit({ mode: "testnet" }, false)).toBe("sats");
    expect(pageUnit({ mode: "mainnet" }, true)).toBe("test sats");
    expect(pageUnit({ mode: "mainnet" }, false)).toBe("sats");
  });
});

describe("Fedimint", () => {
  const federation = (over: Record<string, unknown> = {}) => ({ id: "ab".repeat(32), name: "Ghostly regtest", guardians: [{ name: "g0", url: "ws://127.0.0.1:47095" }], consensusVersion: "2.1", network: "regtest" as const,
    modules: ["ln", "mint", "wallet"], joinedAt: 1, invite: "fed11qq", balance: 0, status: "ready" as const, lightning: true, ...over });
  it("says it is Testnet only on Mainnet", () => {
    expect(cardOf("fedimint", { fedimint: { unavailable: "not yet", federations: [], balance: 0, history: [] } }))
      .toEqual({ name: "Fedimint", balance: "Testnet only", detail: "Federation ecash", status: "Not on Mainnet yet", ready: false });
  });
  it("asks for a federation, and joins none by itself", () => {
    expect(cardOf("fedimint", { mode: "testnet", fedimint: { federations: [], balance: 0, history: [] } })).toMatchObject({ balance: "No federation", status: "Set up", ready: false });
  });
  it("shows the balance of its federations, named, once one is connected", () => {
    expect(cardOf("fedimint", { mode: "testnet", fedimint: { federations: [federation({ balance: 1_200 })], balance: 1_200, history: [] } }))
      .toEqual({ name: "Fedimint", balance: "1,200 test sats", detail: "Ghostly regtest", status: "Ready", ready: true });
    expect(pageCardOf("fedimint", { mode: "testnet", fedimint: { federations: [federation({ balance: 5 }), federation({ id: "cd".repeat(32), balance: 7 })], balance: 12, history: [] } }))
      .toMatchObject({ balance: "12 sats", detail: "2 federations" });
    expect(cardOf("fedimint", { mode: "testnet", fedimint: { federations: [federation({ status: "connecting" })], balance: 0, history: [] } })).toMatchObject({ balance: "Connecting…", ready: false });
    expect(cardOf("fedimint", { mode: "testnet", fedimint: { federations: [federation({ status: "error" })], balance: 0, history: [] } })).toMatchObject({ balance: "Unavailable", ready: false });
  });
});
