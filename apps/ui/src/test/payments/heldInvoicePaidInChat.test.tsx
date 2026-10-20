import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { fakeInvoice } from "@ghostly/browser/engine/paymentAdapters/providers/testing";
import { MessageBubble } from "../../components/MessageBubble";
import { fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";
import { lightningSource, TEST_MINT } from "./fixtures";

// covers: wallet.testnet.receive-held

/**
 * A test mint's Receive invoice counts only once a payer says it paid it (the engine's held quote). Paid from its card in
 * a chat, the engine is told which chat it was in, so the contact who made it hears it was paid.
 */

describe("a Testnet invoice paid from its card in a chat", () => {
  it("names the chat and the invoice, so the contact is told", async () => {
    const invoice = fakeInvoice(25, new Uint8Array(32).fill(9));
    fakeEngine.setState({ links: [linkView()], wallet: { lightning: lightningSource({ mode: "testnet", providerId: "fake-lightning" }) } });
    const view = renderApp(<MessageBubble message={{ id: "m1", text: invoice, sender: "peer", timestamp: Date.now(), status: "delivered" } as never} peerPubKey="peer" />);
    view.engine.on("walletQuoteInvoice", () => ({ quote: "melt-1", mint: TEST_MINT, amount: 25, feeReserve: 0, source: "cashu-mint" })).on("walletPayQuote", () => ({ paid: true }));
    await view.user.click(within(screen.getByTestId("invoice-bubble")).getByTestId("invoice-pay"));
    await view.user.click(await screen.findByTestId("invoice-confirm"));
    expect(await screen.findByTestId("invoice-paid")).toBeInTheDocument();
    expect(view.engine.callsTo("walletPayQuote")).toEqual([{ quote: "melt-1", mint: TEST_MINT, linkId: "link-1", invoice }]);
  });
});
