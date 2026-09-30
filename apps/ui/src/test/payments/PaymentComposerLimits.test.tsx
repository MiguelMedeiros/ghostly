import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { WalletInstanceView, WalletView } from "@ghostly/browser/shared/types";
import type { WalletNetwork } from "@ghostly/core";
import { PaymentComposer } from "../../components/PaymentComposer";
import { rememberRail } from "../../lib/chatPayments";
import { fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";
import { REAL_MINT, everyWallet, lightningSource, mint, reviewContext, usdtReady } from "./fixtures";

// covers: payments.usdt.send, payments.bitcoin.offer, payments.chat.networks

/**
 * Two things the composer used to get wrong, found by these tests: USDT's over-balance check, and how an unready
 * card explains itself.
 */

function open(wallet: Partial<WalletView>, sendUnavailable?: string) {
  fakeEngine.setState({ links: [linkView()], wallet });
  return renderApp(<PaymentComposer balance={1_000} onSend={async () => null} onRequest={async () => null} onClose={() => {}} reviewContext={reviewContext()} contact="Alice" sendUnavailable={sendUnavailable} />);
}

/** A wallet the profile has, as the engine lists it, for one the flat fields would not make (nothing set up yet). */
const instance = (type: WalletInstanceView["type"], network: WalletNetwork): WalletInstanceView => ({ id: `${type}:${network}`, type, network, config: {} });

// USDT's balance is in the token's smallest units (2 TEST-USDT is "2000000") and the amount in whole tokens. It
// was compared as is: 3 on a card holding 2 passed, and the hint only came past 2,000,000 tokens.
it("warns when a USDT amount is more than the card holds", async () => {
  rememberRail("peer", "usdt:testnet");
  const { user } = open(everyWallet({ usdt: usdtReady({ balance: "2000000", decimals: 6 }) }));
  await user.click(screen.getByTestId("payment-use"));
  await user.type(screen.getByTestId("payment-amount"), "3");
  expect(screen.getByText("More than the 2 TEST-USDT on this card.")).toBeInTheDocument();
  expect(screen.getByTestId("payment-send")).toBeDisabled();
});

// A Lightning card on its own node (LND, CLN, NWC, Breez...) was checked against the Cashu balance: with no ecash, any
// amount said "More than the 0 sats on this card". It reads its own source's balance, and claims none it has not read.
describe("a Lightning card with its own source", () => {
  const lightningOn = (lightning: Partial<NonNullable<WalletView["lightning"]>>) => {
    rememberRail("peer", "lightning:mainnet");
    return open(everyWallet({ mints: [mint(REAL_MINT, 0)], balance: 0, lightning: lightningSource({ providerId: "lnd-1", alias: "My node", ...lightning }) }));
  };

  it("checks an amount against its source's balance, not the Cashu one", async () => {
    const { user } = lightningOn({ balance: 5_000 });
    await user.click(screen.getByTestId("payment-use"));
    expect(screen.getByTestId("payment-back")).toHaveClass("wallet-card-lightning");
    await user.type(screen.getByTestId("payment-amount"), "100");
    expect(screen.queryByText(/^More than/)).not.toBeInTheDocument();
    expect(screen.getByTestId("payment-request")).toBeEnabled();
    // Lightning in a chat can only Request, and a request spends nothing: no amount is more than the card holds.
    await user.clear(screen.getByTestId("payment-amount"));
    await user.type(screen.getByTestId("payment-amount"), "6000");
    expect(screen.queryByText(/^More than/)).not.toBeInTheDocument();
    expect(document.querySelector(".payment-back-hint")).not.toHaveTextContent(/More than/);
    expect(screen.getByTestId("payment-request")).toBeEnabled();
  });

  // Ready, but its source has not said what it holds: no number to compare with. (One reconnecting or failing is not
  // ready, so the sheet does not open on it: walletCardData.test.ts has those.)
  it("claims no number while its source has not read a balance", async () => {
    const { user } = lightningOn({});
    await user.click(screen.getByTestId("payment-use"));
    expect(screen.getByTestId("payment-back")).toHaveClass("wallet-card-lightning");
    await user.type(screen.getByTestId("payment-amount"), "100");
    expect(screen.queryByText(/^More than/)).not.toBeInTheDocument();
    expect(screen.getByTestId("payment-request")).toBeEnabled();
  });
});

// "More than the X on this card" is about Send, which spends from the card. A Request spends nothing, so it said
// "More than the 1,000 sats" on a Lightning card (which can only Request in a chat) asked for 2,000. Every rail that
// can Send warns and keeps Send off; Request stays on, and where Request is all there is, nothing warns.
describe("the over-balance hint", () => {
  const fed = { federations: [{ id: "ab".repeat(32), name: "Fed", guardians: [], consensusVersion: "2.1", network: "regtest" as const, modules: [], joinedAt: 1, invite: "fed11qq", balance: 2_000, status: "ready" as const, lightning: true }], balance: 2_000, history: [] };
  const over = async (id: string, typed: string, wallet: Partial<WalletView> = {}, sendUnavailable?: string) => {
    rememberRail("peer", id);
    const { user } = open(everyWallet({ fedimint: fed, ...wallet }), sendUnavailable);
    await user.click(screen.getByTestId("payment-use"));
    expect(screen.getByTestId("payment-back")).toHaveClass(`wallet-card-${id.split(":")[0]}`);
    await user.type(screen.getByTestId("payment-amount"), typed);
  };

  it.each([
    ["cashu:mainnet", "1500", "More than the 1,000 sats on this card."],
    ["arkade:testnet", "6000", "More than the 5,000 test sats on this card."],
    ["bark:testnet", "4000", "More than the 3,000 test sats on this card."],
    ["spark:testnet", "5000", "More than the 4,000 test sats on this card."],
    ["bitcoin:mainnet", "20000", "More than the 10,000 sats on this card."],
    ["fedimint:testnet", "3000", "More than the 2,000 test sats on this card."],
    ["usdt:testnet", "6", "More than the 5 TEST-USDT on this card."],
  ])("%s, which can Send, warns past its balance and keeps only Request on", async (id, typed, hint) => {
    await over(id, typed);
    expect(screen.getByText(hint)).toBeInTheDocument();
    expect(screen.getByTestId("payment-amount").closest("label")).toHaveAttribute("data-over", "true");
    expect(screen.getByTestId("payment-send")).toBeDisabled();
    expect(screen.getByTestId("payment-request")).toBeEnabled();
  });

  it("says nothing of the balance on Lightning through the Cashu mints, which can only Request", async () => {
    await over("lightning:mainnet", "2000");
    expect(screen.queryByText(/^More than/)).not.toBeInTheDocument();
    expect(screen.getByTestId("payment-amount").closest("label")).not.toHaveAttribute("data-over");
    expect(screen.getByTestId("payment-request")).toBeEnabled();
  });

  it("says nothing of the balance on a request to a group, which has no Send", async () => {
    await over("cashu:mainnet", "1500", {}, "A request to the group is paid by one member");
    expect(screen.queryByText(/^More than/)).not.toBeInTheDocument();
    expect(screen.getByTestId("payment-send")).toBeDisabled();
    expect(screen.getByTestId("payment-request")).toBeEnabled();
  });
});

// A card that is not ready explains itself with its balance line ("Ark is connecting…"), but one with nothing set
// up said "Cashu is 0 sats" (as if money were the problem) or "Bitcoin is no source". It says it is not set up.
it("says a Cashu card without a mint has to be set up, not that it holds 0 sats", () => {
  open(everyWallet({ mints: [], balance: 0, wallets: [instance("cashu", "mainnet"), instance("arkade", "testnet")] }));
  const cashu = screen.getByTestId("payment-card-cashu-mainnet");
  expect(cashu).toHaveAttribute("aria-disabled", "true");
  expect(cashu.getAttribute("title")).not.toBe("Cashu is 0 sats");
  expect(cashu.getAttribute("title")).toMatch(/set up/i);
});

it("says Lightning through the Cashu mints has to be set up when there is no mint", () => {
  open(everyWallet({ mints: [], balance: 0, lightning: undefined, wallets: [instance("lightning", "mainnet"), instance("arkade", "testnet")] }));
  expect(screen.getByTestId("payment-card-lightning-mainnet").getAttribute("title")).toBe("Lightning is not set up yet");
});

it("still says where a card on its way is", () => {
  // An Ark wallet whose provider has not answered yet: it has no address to be paid at.
  open(everyWallet({ ark: undefined, wallets: [instance("arkade", "testnet")] }));
  expect(screen.getByTestId("payment-card-arkade-testnet").getAttribute("title")).toBe("Ark is connecting…");
});

it("says a Bitcoin card without a source has to be set up", () => {
  open(everyWallet({ bitcoin: undefined, wallets: [instance("cashu", "mainnet"), instance("bitcoin", "mainnet")] }));
  expect(screen.getByTestId("payment-card-bitcoin-mainnet").getAttribute("title")).toMatch(/set up/i);
});

it("shows no card for a wallet the profile does not have", () => {
  // No source, no Ark: the engine lists no such wallet, so the chat has no card for it.
  open(everyWallet({ bitcoin: undefined, ark: undefined }));
  expect(screen.queryByTestId("payment-card-bitcoin-mainnet")).not.toBeInTheDocument();
  expect(screen.queryByTestId("payment-card-arkade-testnet")).not.toBeInTheDocument();
  expect(screen.getByTestId("payment-card-cashu-mainnet")).toBeInTheDocument();
});
