import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MessageBubble } from "../../components/MessageBubble";
import { fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";
import { fakeInvoice } from "@ghostly/browser/engine/paymentAdapters/providers/testing";
import { lightningSource } from "./fixtures";

// covers: payments.cashu.token-card, payments.lightning.invoice-card

/**
 * Redeemed and Paid belong to the token or invoice that was redeemed or paid, whole: other money that ends the same
 * way, or carries the same payment hash, is offered as any money never dealt with here.
 */

const message = (id: string, text: string) => ({ id, text, sender: "peer", timestamp: Date.now(), status: "delivered" }) as never;

describe("the Redeemed mark of an ecash token", () => {
  it("is not shown on another token that ends with the same characters", async () => {
    const tail = "o".repeat(60);
    const redeemed = `cashuBa${tail}`;
    const other = `cashuBb${tail}`;
    fakeEngine.setState({ links: [linkView()] });
    fakeEngine.on("walletInspectCashu", () => ({ inspection: { kind: "token", amount: 1008, unit: "sat", mint: "https://mint.example.com", accepted: true } }));
    const view = renderApp(<MessageBubble message={message("m1", redeemed)} peerPubKey="peer" />);
    view.engine.on("walletReceiveToken", () => ({ amount: 1008 }));
    await view.user.click(within(await screen.findByTestId("cashu-token-bubble")).getByTestId("token-redeem"));
    expect(await screen.findByTestId("token-redeemed")).toBeInTheDocument();
    view.unmount();

    renderApp(<MessageBubble message={message("m2", other)} peerPubKey="peer" />);
    const card = await screen.findByTestId("cashu-token-bubble");
    expect(within(card).queryByTestId("token-redeemed")).not.toBeInTheDocument();
    expect(within(card).getByTestId("token-redeem")).toBeInTheDocument();
  });

  it("is still shown on the token that was redeemed", async () => {
    const token = `cashuBa${"o".repeat(60)}`;
    fakeEngine.setState({ links: [linkView()] });
    fakeEngine.on("walletInspectCashu", () => ({ inspection: { kind: "token", amount: 1008, unit: "sat", mint: "https://mint.example.com", accepted: true } }));
    const view = renderApp(<MessageBubble message={message("m1", token)} peerPubKey="peer" />);
    view.engine.on("walletReceiveToken", () => ({ amount: 1008 }));
    await view.user.click(within(await screen.findByTestId("cashu-token-bubble")).getByTestId("token-redeem"));
    expect(await screen.findByTestId("token-redeemed")).toBeInTheDocument();
    view.unmount();

    renderApp(<MessageBubble message={message("m2", token)} peerPubKey="peer" />);
    expect(await screen.findByTestId("token-redeemed")).toBeInTheDocument();
  });

  // Spent at the mint says nothing of who spent it: the contact, someone they sent it to, or this device before. Nothing
  // came in, so the card says spent and offers nothing more, and never claims Redeemed.
  it("is not shown when the mint says the token was already spent", async () => {
    const token = `cashuBa${"o".repeat(60)}`;
    fakeEngine.setState({ links: [linkView()] });
    fakeEngine.on("walletInspectCashu", () => ({ inspection: { kind: "token", amount: 1008, unit: "sat", mint: "https://mint.example.com", accepted: true } }));
    const view = renderApp(<MessageBubble message={message("m1", token)} peerPubKey="peer" />);
    view.engine.on("walletReceiveToken", () => {
      throw new Error("This ecash was already spent somewhere else");
    });
    const card = await screen.findByTestId("cashu-token-bubble");
    await view.user.click(within(card).getByTestId("token-redeem"));
    expect(await within(card).findByTestId("token-spent")).toHaveTextContent("Already spent");
    expect(within(card).queryByTestId("token-redeem")).not.toBeInTheDocument();
    expect(within(card).queryByTestId("token-redeemed")).not.toBeInTheDocument();
    expect(card).not.toHaveTextContent(/Redeemed/);
    view.unmount();

    renderApp(<MessageBubble message={message("m2", token)} peerPubKey="peer" />);
    const later = await screen.findByTestId("cashu-token-bubble");
    expect(within(later).queryByTestId("token-redeemed")).not.toBeInTheDocument();
  });

  it("is not shown when the redeem fails for another reason", async () => {
    const token = `cashuBa${"o".repeat(60)}`;
    fakeEngine.setState({ links: [linkView()] });
    fakeEngine.on("walletInspectCashu", () => ({ inspection: { kind: "token", amount: 1008, unit: "sat", mint: "https://mint.example.com", accepted: true } }));
    const view = renderApp(<MessageBubble message={message("m1", token)} peerPubKey="peer" />);
    view.engine.on("walletReceiveToken", () => {
      throw new Error("Could not reach mint.example.com");
    });
    const card = await screen.findByTestId("cashu-token-bubble");
    await view.user.click(within(card).getByTestId("token-redeem"));
    await waitFor(() => expect(within(card).getByTestId("token-redeem")).toBeEnabled());
    expect(within(card).queryByTestId("token-redeemed")).not.toBeInTheDocument();
  });
});

describe("the Paid mark of a Lightning invoice", () => {
  it("is not shown on another invoice with the same payment hash", async () => {
    const hash = new Uint8Array(32).fill(7);
    const paid = fakeInvoice(100, hash);
    const other = fakeInvoice(50_000, hash);
    fakeEngine.setState({ links: [linkView()], wallet: { lightning: lightningSource({ mode: "testnet", providerId: "fake-lightning" }) } });
    const view = renderApp(<MessageBubble message={message("m1", paid)} peerPubKey="peer" />);
    view.engine.on("walletQuoteInvoice", () => ({ quote: "quote-A", mint: "", amount: 100, feeReserve: 1, source: "fake-lightning" })).on("walletPayQuote", () => ({ paid: true }));
    await view.user.click(within(screen.getByTestId("invoice-bubble")).getByTestId("invoice-pay"));
    await view.user.click(await screen.findByTestId("invoice-confirm"));
    expect(await screen.findByTestId("invoice-paid")).toBeInTheDocument();
    view.unmount();

    renderApp(<MessageBubble message={message("m2", other)} peerPubKey="peer" />);
    const card = screen.getByTestId("invoice-bubble");
    expect(within(card).getByTestId("money-amount")).toHaveTextContent("50,000");
    expect(within(card).queryByTestId("invoice-paid")).not.toBeInTheDocument();
    expect(within(card).getByTestId("invoice-pay")).toBeInTheDocument();
  });
});
