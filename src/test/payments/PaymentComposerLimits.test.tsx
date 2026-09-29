import { screen } from "@testing-library/react";
import { expect, it } from "vitest";
import type { WalletInstanceView, WalletView } from "@ghostly/browser/shared/types";
import type { WalletNetwork } from "@ghostly/core";
import { PaymentComposer } from "../../components/PaymentComposer";
import { rememberRail } from "../../lib/chatPayments";
import { fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";
import { everyWallet, reviewContext, usdtReady } from "./fixtures";

// covers: payments.usdt.send, payments.bitcoin.offer, payments.chat.networks

/**
 * Two things the composer used to get wrong, found by these tests: USDT's over-balance check, and how an unready
 * card explains itself.
 */

function open(wallet: Partial<WalletView>) {
  fakeEngine.setState({ links: [linkView()], wallet });
  return renderApp(<PaymentComposer balance={1_000} onSend={async () => null} onRequest={async () => null} onClose={() => {}} reviewContext={reviewContext()} contact="Alice" />);
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
