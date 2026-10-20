import { Profiler } from "react";
import { act, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { fakeInvoice } from "@ghostly/browser/engine/paymentAdapters/providers/testing";
import { MessageBubble } from "../../components/MessageBubble";
import { ALL_METHODS_ON } from "../../lib/chatPayments";
import { fakeEngine, linkView, paymentView, type StatePatch } from "../fakeEngine";
import { renderApp } from "../render";
import { lightningSource } from "./fixtures";

// covers: payments.lightning.invoice-card

/**
 * The engine sends its whole state anew on every change, up to 20 times a second while a file moves. Money in a chat
 * (an invoice's card with its QR code, a payment request's bubble, an on-chain address) draws again only when what it
 * shows changes: the wallets, its payment, the chat's ways of paying.
 */

const message = (id: string, text: string, paymentId?: string) => ({ id, text, sender: "peer", timestamp: Date.now(), status: "delivered", ...(paymentId ? { paymentId } : {}) }) as never;
const INVOICE = fakeInvoice(25, new Uint8Array(32).fill(7));
const REQUEST_INVOICE = fakeInvoice(40, new Uint8Array(32).fill(8));

function setUp() {
  fakeEngine.setState({
    links: [linkView()],
    payments: { "req-1": paymentView({ id: "req-1", kind: "request", direction: "in", amount: 40, invoice: REQUEST_INVOICE }) },
    wallet: { lightning: lightningSource({ mode: "testnet", providerId: "fake-lightning" }) },
  });
  let commits = 0;
  const view = renderApp(
    <Profiler id="chat" onRender={() => { commits++; }}>
      <MessageBubble message={message("m1", INVOICE)} peerPubKey="peer" />
      <MessageBubble message={message("m2", "request", "req-1")} peerPubKey="peer" />
      <MessageBubble message={message("m3", "bitcoin:tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx?amount=0.0001")} peerPubKey="peer" />
    </Profiler>,
  );
  return { view, commits: () => commits };
}

/** The state as the engine sends it after a change elsewhere: the same content, every object new. */
const sentAgain = (patch: StatePatch = {}) => act(() => fakeEngine.setState({ ...structuredClone(fakeEngine.state), ...patch } as StatePatch));

describe("money in a chat on an engine state", () => {
  it("is not drawn again when nothing it shows changed", async () => {
    const { commits } = setUp();
    expect(screen.getByTestId("invoice-bubble")).toBeInTheDocument();
    expect(screen.getByTestId("payment-bubble")).toBeInTheDocument();
    const before = commits();
    for (let i = 0; i < 5; i++) sentAgain({ transfers: { [`file-${i}`]: { state: "transferring", transferred: i * 1000, size: 10_000 } } });
    expect(commits() - before).toBe(0);
  });

  it("is drawn again when its payment, the wallets or the chat's ways of paying change", async () => {
    const { commits } = setUp();
    const before = commits();
    sentAgain({ payments: { "req-1": paymentView({ id: "req-1", kind: "request", direction: "in", amount: 40, invoice: REQUEST_INVOICE, state: "settled" }) } });
    expect(screen.getByTestId("payment-bubble")).toHaveAttribute("data-state", "settled");
    sentAgain({ wallet: { lightning: lightningSource({ mode: "testnet", providerId: "fake-lightning" }), wallets: [] } });
    expect(within(screen.getByTestId("invoice-bubble")).queryByTestId("invoice-pay")).not.toBeInTheDocument();
    sentAgain({ links: [linkView({ paymentMethods: { ...ALL_METHODS_ON, lightning: false } })] });
    expect(screen.getAllByTestId("money-off").length).toBeGreaterThan(0);
    expect(commits() - before).toBeGreaterThanOrEqual(3);
  });
});
