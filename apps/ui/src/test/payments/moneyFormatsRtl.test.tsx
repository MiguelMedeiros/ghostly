import { screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { SEPOLIA_TEST_USDT } from "@ghostly/core";
import { MessageBubble } from "../../components/MessageBubble";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";
import { EVM, XMR_STAGENET, bcrt1q, bolt12Offer } from "./moneyFormatFixtures";

// covers: payments.money.onchain-card, payments.money.bolt12-card, payments.money.usdt-card, payments.money.monero-card, app.i18n

/**
 * In Arabic the pasted money cards read as the Lightning invoice's card does (InvoiceBubble): only the number is
 * isolated, so the unit stays in the line's direction, and what someone else wrote keeps its own direction. A bare
 * number glued to "sats تجريبية" was one left-to-right run with "sats", read "sats 12,345 تجريبية" from the right, and a
 * label "1 cup coffee" read "cup coffee 1".
 */
const MEMO = "1 cup coffee";

function bubble(text: string) {
  return renderApp(<MessageBubble message={{ id: "m1", text, sender: "peer", timestamp: 1_700_000_000_000 }} peerPubKey="peer" />, { language: "ar" });
}

beforeEach(() => fakeEngine.reset());

describe("in Arabic, a pasted money card keeps its amount whole and its words in their own direction", () => {
  it("a bitcoin: link", () => {
    bubble(`bitcoin:${bcrt1q()}?amount=0.00012345&label=${encodeURIComponent(MEMO)}`);
    const card = screen.getByTestId("onchain-bubble");
    expect(within(card).getByTestId("money-amount").tagName).toBe("BDI");
    expect(within(card).getByText(MEMO)).toHaveAttribute("dir", "auto");
  });

  it("a BOLT 12 offer", () => {
    bubble(bolt12Offer({ chains: ["regtest"], amountMsat: 21_000_000, description: MEMO }));
    const card = screen.getByTestId("bolt12-bubble");
    expect(within(card).getByTestId("money-amount").tagName).toBe("BDI");
    expect(within(card).getByText(MEMO)).toHaveAttribute("dir", "auto");
  });

  it("a USDT link", () => {
    bubble(`ethereum:${SEPOLIA_TEST_USDT}@11155111/transfer?address=${EVM}&uint256=2.5e6`);
    expect(within(screen.getByTestId("usdt-bubble")).getByTestId("money-amount").tagName).toBe("BDI");
  });

  it("a monero: link", () => {
    bubble(`monero:${XMR_STAGENET}?tx_amount=0.25&tx_description=${encodeURIComponent(MEMO)}`);
    const card = screen.getByTestId("monero-bubble");
    expect(within(card).getByTestId("money-amount").tagName).toBe("BDI");
    expect(within(card).getByText(MEMO)).toHaveAttribute("dir", "auto");
  });
});
