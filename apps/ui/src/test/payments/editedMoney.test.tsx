import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MessageBubble } from "../../components/MessageBubble";
import type { LightningAddressInfo } from "../../lib/platform";
import { fakeEngine, linkView, walletView } from "../fakeEngine";
import { renderApp } from "../render";
import { fakeInvoice } from "@ghostly/browser/engine/paymentAdapters/providers/testing";
import { lightningSource, mint, TEST_MINT } from "./fixtures";

// covers: payments.lightning.invoice-card, payments.lnurl.card

/**
 * A message holding money can be edited by the one who sent it. The card then shows what the message holds now, and
 * only that: a review started for the money before the edit is dropped, and Paid is only ever kept for what was paid.
 */

const SETTLED_KEY = "ghostly_settled_money";
const hash = (fill: number) => Buffer.from(new Uint8Array(32).fill(fill)).toString("hex");
const message = (text: string) => ({ id: "m1", text, sender: "peer", timestamp: Date.now(), status: "delivered" }) as never;

describe("an edited message with a Lightning invoice", () => {
  const first = fakeInvoice(100, new Uint8Array(32).fill(1));
  const edited = fakeInvoice(50_000, new Uint8Array(32).fill(2));

  it("drops the review of the invoice it held: Pay starts again, and the new invoice is not marked Paid", async () => {
    fakeEngine.setState({ links: [linkView()], wallet: { lightning: lightningSource({ mode: "testnet", providerId: "fake-lightning" }) } });
    const view = renderApp(<MessageBubble message={message(first)} peerPubKey="peer" />);
    view.engine.on("walletQuoteInvoice", () => ({ quote: "quote-A", mint: "", amount: 100, feeReserve: 1, source: "fake-lightning" })).on("walletPayQuote", () => ({ paid: true }));
    await view.user.click(within(screen.getByTestId("invoice-bubble")).getByTestId("invoice-pay"));
    expect(await screen.findByTestId("invoice-confirm")).toBeInTheDocument();

    view.rerender(<MessageBubble message={message(edited)} peerPubKey="peer" />);
    const card = screen.getByTestId("invoice-bubble");
    expect(within(card).getByTestId("money-amount")).toHaveTextContent("50,000");
    expect(within(card).queryByTestId("invoice-confirm")).not.toBeInTheDocument();
    expect(within(card).getByTestId("invoice-pay")).toBeInTheDocument();
    expect(view.engine.callsTo("walletPayQuote")).toEqual([]);
    expect(localStorage.getItem(SETTLED_KEY) ?? "[]").not.toContain(hash(2));
  });

  it("an invoice paid before the edit is the one marked Paid", async () => {
    fakeEngine.setState({ links: [linkView()], wallet: { lightning: lightningSource({ mode: "testnet", providerId: "fake-lightning" }) } });
    const view = renderApp(<MessageBubble message={message(first)} peerPubKey="peer" />);
    let release!: () => void;
    view.engine.on("walletQuoteInvoice", () => ({ quote: "quote-A", mint: "", amount: 100, feeReserve: 1, source: "fake-lightning" }))
      .on("walletPayQuote", () => new Promise((resolve) => { release = () => resolve({ paid: true }); }));
    await view.user.click(within(screen.getByTestId("invoice-bubble")).getByTestId("invoice-pay"));
    await view.user.click(await screen.findByTestId("invoice-confirm"));
    view.rerender(<MessageBubble message={message(edited)} peerPubKey="peer" />);
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const settled = localStorage.getItem(SETTLED_KEY) ?? "[]";
    expect(settled).toContain(hash(1));
    expect(settled).not.toContain(hash(2));
    expect(within(screen.getByTestId("invoice-bubble")).queryByTestId("invoice-paid")).not.toBeInTheDocument();
  });
});

describe("an edited message with a Lightning address", () => {
  it("asks the new address, not the one looked up before the edit", async () => {
    fakeEngine.setState({ links: [linkView()], wallet: walletView({ mode: "testnet", mints: [mint(TEST_MINT, 10_000)], balance: 10_000 }) });
    const view = renderApp(<MessageBubble message={message("alice@example.com")} peerPubKey="peer" />);
    const info = (text: string) => ({ id: `id-${text}`, kind: "address", text, domain: "example.com", callbackDomain: "example.com", minSat: 1, maxSat: 100_000, description: text, commentAllowed: 0 }) as LightningAddressInfo;
    view.engine.on("lnurlResolve", (params) => info((params as { text: string }).text)).on("lnurlInvoice", () => ({ invoice: "lnbc-invoice", note: "" }));
    await view.user.click(screen.getByTestId("lnurl-pay-open"));
    await view.user.click(screen.getByTestId("lnurl-lookup"));
    expect(await screen.findByTestId("lnurl-amount")).toBeInTheDocument();

    view.rerender(<MessageBubble message={message("bob@example.com")} peerPubKey="peer" />);
    expect(screen.getByTestId("lnurl-text")).toHaveTextContent("bob@example.com");
    expect(screen.queryByTestId("lnurl-amount")).not.toBeInTheDocument();
    expect(view.engine.callsTo("lnurlInvoice")).toEqual([]);
  });
});
