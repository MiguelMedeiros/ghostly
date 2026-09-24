import { describe, expect, it } from "vitest";
import type { WalletView } from "@ghostly/browser/shared/types";
import { TEST_MINTS } from "@ghostly/browser/shared/mints";
import { walletCards, type WalletRail } from "../../components/walletCardData";
import { walletView } from "../fakeEngine";
import { arkReady, barkReady, bitcoinSource, lightningSource, mint, REAL_MINT, TEST_MINT, usdtReady } from "./fixtures";

/** One card, as the wallet page and the chat's picker show it. */
const cardOf = (rail: WalletRail, wallet: Partial<WalletView> = {}) => {
  const { id: _, ...shown } = walletCards(walletView(wallet), TEST_MINTS).find((c) => c.id === rail)!;
  return shown;
};

it("lists every wallet, in the deck's order", () => {
  expect(walletCards(walletView(), TEST_MINTS).map((c) => c.id)).toEqual(["cashu", "lightning", "arkade", "bark", "bitcoin", "usdt"]);
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
    expect(cardOf("bitcoin", { bitcoin: bitcoinSource({ status: state }) })).toMatchObject({ balance, status, ready: false });
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
