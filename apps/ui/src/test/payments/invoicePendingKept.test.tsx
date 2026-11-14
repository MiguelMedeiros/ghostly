import { act, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { decodeBolt11 } from "@ghostly/core";
import type { WalletView } from "@ghostly/browser/shared/types";
import { MessageBubble } from "../../components/MessageBubble";
import { fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";
import { fakeInvoice } from "@ghostly/browser/engine/paymentAdapters/providers/testing";
import { lightningSource, mint, TEST_MINT } from "./fixtures";

// covers: payments.lightning.invoice-card

/**
 * A payment of a contact's invoice that did not settle at once stays pending in the wallet's Lightning journal: the
 * card reads it from there, so drawn again (another chat and back, a reload) it still says so, with no Pay and no
 * Open wallet, until the journal says it was paid or failed. And it names who holds it: the mint only for the mints.
 */

const invoice = fakeInvoice(2_000, new Uint8Array(32).fill(9));
const paymentHash = decodeBolt11(invoice)!.paymentHash!;
type Op = NonNullable<WalletView["lightning"]>["recent"][number];
const op = (providerId: string, state: Op["state"], error?: string): Op =>
  ({ direction: "out", providerId, mode: "testnet", paymentHash, invoice, amount: 2_000, expiresAt: 0, createdAt: Date.now(), state, ...(error ? { error } : {}) });
const source = (providerId: string, recent: Op[] = [], name?: string) =>
  lightningSource({ mode: "testnet", providerId, ...(name ? { name } : {}), recent } as Partial<NonNullable<WalletView["lightning"]>>);

const draw = () => renderApp(<MessageBubble message={{ id: "m1", text: invoice, sender: "peer", timestamp: Date.now(), status: "delivered" } as never} peerPubKey="peer" />);

/** Pays the invoice from a card that leaves it pending; the wallet's journal then holds it, as the engine's does. */
const payPending = async (providerId: string, name?: string) => {
  // The mints' card pays from the mints' ecash.
  const mints = providerId === "cashu-mint" ? { mints: [mint(TEST_MINT, 5_000)], balance: 5_000 } : {};
  fakeEngine.setState({ links: [linkView()], wallet: { ...mints, lightning: source(providerId, [], name) } });
  const view = draw();
  view.engine.on("walletQuoteInvoice", () => ({ quote: "q-1", mint: providerId === "cashu-mint" ? TEST_MINT : "", amount: 2_000, feeReserve: 5, source: providerId }))
    .on("walletPayQuote", () => ({ paid: false }));
  const card = screen.getByTestId("invoice-bubble");
  await view.user.click(within(card).getByTestId("invoice-pay"));
  await view.user.click(await within(card).findByTestId("invoice-confirm"));
  act(() => view.engine.update({ wallet: { ...mints, lightning: source(providerId, [op(providerId, "pending")], name) } }));
  expect(await within(card).findByTestId("invoice-pending")).toBeInTheDocument();
  return view;
};

describe("a contact's Lightning invoice paid and left pending", () => {
  it("is still pending when the card is drawn again: no Pay, no Open wallet", async () => {
    const first = await payPending("fake-lightning", "Test node");
    first.unmount();
    draw();
    const card = screen.getByTestId("invoice-bubble");
    expect(within(card).getByTestId("invoice-pending")).toHaveTextContent("Payment pending at Test node…");
    expect(within(card).queryByTestId("invoice-pay")).not.toBeInTheDocument();
    expect(within(card).queryByTestId("invoice-open-wallet")).not.toBeInTheDocument();
    expect(card).not.toHaveTextContent(/Expires in/);
  });

  it("says the mint only when the mints pay it", async () => {
    await payPending("cashu-mint");
    expect(screen.getByTestId("invoice-pending")).toHaveTextContent("Payment pending at the mint…");
  });

  it("names no mint for a card on its own node", async () => {
    await payPending("fake-lightning");
    expect(screen.getByTestId("invoice-pending")).toHaveTextContent(/^Payment pending…$/);
  });

  it("turns Paid once the wallet settles it", async () => {
    const { engine } = await payPending("fake-lightning", "Test node");
    act(() => engine.update({ wallet: { lightning: source("fake-lightning", [op("fake-lightning", "paid")], "Test node") } }));
    expect(await screen.findByTestId("invoice-paid")).toBeInTheDocument();
  });

  it("offers Pay again, and says why, once it fails", async () => {
    const { engine } = await payPending("fake-lightning", "Test node");
    act(() => engine.update({ wallet: { lightning: source("fake-lightning", [op("fake-lightning", "failed", "no route")], "Test node") } }));
    const card = screen.getByTestId("invoice-bubble");
    expect(await within(card).findByTestId("invoice-pay")).toBeInTheDocument();
    expect(within(card).queryByTestId("invoice-pending")).not.toBeInTheDocument();
    expect(card).toHaveTextContent(/no route/);
  });

  it("is pending as soon as the wallet's journal has it, even where Pay was never pressed", () => {
    fakeEngine.setState({ links: [linkView()], wallet: { lightning: source("fake-lightning", [op("fake-lightning", "unknown")]) } });
    draw();
    expect(screen.getByTestId("invoice-pending")).toBeInTheDocument();
    expect(screen.queryByTestId("invoice-pay")).not.toBeInTheDocument();
  });
});
