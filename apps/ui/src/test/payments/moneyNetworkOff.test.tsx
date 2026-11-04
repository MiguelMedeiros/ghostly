import { screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { fakeInvoice } from "@ghostly/browser/engine/paymentAdapters/providers/testing";
import type { LinkView, WalletView } from "@ghostly/browser/shared/types";
import { MessageBubble } from "../../components/MessageBubble";
import { fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";
import { lightningSource, mint, TEST_MINT } from "./fixtures";

// covers: payments.lightning.invoice-card, payments.cashu.token-card, payments.money.onchain-card

/**
 * A chat can take a way of paying on one network and not the other (Testnet Lightning off, Mainnet Lightning on). A
 * contact's money of a network turned off in the chat is not paid or redeemed from its card, and the card says it is
 * off here, as when the whole way of paying is off. The same way on the other network is still paid.
 */

const message = (text: string) => ({ id: "m1", text, sender: "peer", timestamp: Date.now(), status: "delivered" }) as never;
const INVOICE = fakeInvoice(25, new Uint8Array(32).fill(7));
const TOKEN = `cashuBa${"o".repeat(60)}`;
const ADDRESS = "bitcoin:tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx?amount=0.0001";

function show(text: string, paymentNetworks: LinkView["paymentNetworks"], wallet: Partial<WalletView> = { lightning: lightningSource({ mode: "testnet", providerId: "fake-lightning" }), mints: [mint(TEST_MINT, 5_000)], balance: 5_000 }) {
  fakeEngine.setState({ links: [linkView({ paymentNetworks })], wallet });
  fakeEngine.on("walletInspectCashu", () => ({ inspection: { kind: "token", amount: 1_000, unit: "sat", mint: TEST_MINT, accepted: true } }));
  return renderApp(<MessageBubble message={message(text)} peerPubKey="peer" />);
}

beforeEach(() => fakeEngine.reset());

describe("a contact's Testnet invoice", () => {
  it("with Testnet Lightning off in the chat, offers no Pay and says Lightning is off here", () => {
    show(INVOICE, { lightning: ["mainnet"] });
    const card = screen.getByTestId("invoice-bubble");
    expect(within(card).getByTestId("invoice-network")).toHaveTextContent("Test money");
    expect(within(card).queryByTestId("invoice-pay")).not.toBeInTheDocument();
    expect(screen.getByTestId("money-off")).toBeInTheDocument();
  });

  it("with only Mainnet Lightning off, is still paid", () => {
    show(INVOICE, { lightning: ["testnet"] });
    expect(within(screen.getByTestId("invoice-bubble")).getByTestId("invoice-pay")).toBeInTheDocument();
    expect(screen.queryByTestId("money-off")).not.toBeInTheDocument();
  });
});

describe("a contact's token of a test mint", () => {
  it("with Testnet Cashu off in the chat, offers no Redeem, not even before it is known, and says Cashu is off here", async () => {
    show(TOKEN, { cashu: ["mainnet"] });
    // Read as soon as the token's card is drawn: Redeem is never offered first and taken away after.
    const card = await screen.findByTestId("cashu-token-bubble");
    expect(within(card).getByTestId("token-network")).toHaveTextContent("Test money");
    expect(within(card).queryByTestId("token-redeem")).not.toBeInTheDocument();
    expect(await screen.findByTestId("money-off")).toBeInTheDocument();
  });

  it("with only Mainnet Cashu off, is still redeemed", async () => {
    show(TOKEN, { cashu: ["testnet"] });
    expect(within(await screen.findByTestId("cashu-token-bubble")).getByTestId("token-redeem")).toBeInTheDocument();
    expect(screen.queryByTestId("money-off")).not.toBeInTheDocument();
  });
});

describe("a contact's Testnet Bitcoin address", () => {
  it("with Testnet Bitcoin off in the chat, says Bitcoin is off here", () => {
    show(ADDRESS, { bitcoin: ["mainnet"] });
    expect(screen.getByTestId("onchain-bubble")).toBeInTheDocument();
    expect(screen.getByTestId("money-off")).toBeInTheDocument();
  });

  it("with only Mainnet Bitcoin off, is not said to be off", () => {
    show(ADDRESS, { bitcoin: ["testnet"] });
    expect(screen.queryByTestId("money-off")).not.toBeInTheDocument();
  });
});
