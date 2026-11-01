import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { PaymentReview as Review } from "@ghostly/core";
import type { PaymentView } from "@ghostly/browser/shared/types";
import { PaymentBubble } from "../../components/PaymentBubble";
import { PaymentReview } from "../../components/PaymentReview";
import { servicesPlatform, type WalletPlatform } from "../../lib/platform";
import { fakeEngine, linkView, paymentView } from "../fakeEngine";
import { MAINNET_INVOICE, mint, REAL_MINT, TEST_MINT } from "./fixtures";
import { renderApp } from "../render";

// covers: payments.chat.review, payments.cashu.request, payments.cashu.reclaim, payments.external

/**
 * A money card in a chat and its review, on a phone: what can be pressed is 44 px tall (`max-md:min-h-11`), as the
 * app's other buttons are there. They were 28 px (Review payment, Pay with another wallet, Take it back, the fee
 * field) and 32 px (Approve, Cancel), and Payment details 16 px. The desktop keeps its sizes.
 */
describe("a money card in a chat on a phone", () => {
  const show = (payment: Partial<PaymentView>) => {
    fakeEngine.setState({ links: [linkView()], wallet: { mints: [mint(REAL_MINT, 5_000), mint(TEST_MINT, 0)] }, payments: { "pay-1": paymentView(payment) } });
    return renderApp(<PaymentBubble paymentId="pay-1" peerPubKey="peer" fallbackText="[a payment]" />);
  };

  it("a request's Review payment, Pay with another wallet and fee field are thumb-sized", () => {
    show({ kind: "request", direction: "in", amount: 2_100, invoice: MAINNET_INVOICE });
    expect(screen.getByRole("button", { name: "Review payment" })).toHaveClass("max-md:min-h-11");
    expect(screen.getByRole("button", { name: "Pay with another wallet" })).toHaveClass("max-md:min-h-11");
    expect(screen.getByRole("textbox", { name: /Maximum fee/ })).toHaveClass("max-md:min-h-11");
  });

  it("ecash sent has a thumb-sized Take it back", () => {
    show({ kind: "payment", direction: "out", state: "pending" });
    expect(screen.getByRole("button", { name: "Take it back" })).toHaveClass("max-md:min-h-11");
  });

  it("its review's Approve, Cancel and Payment details are thumb-sized", () => {
    const review = { method: "cashu", network: "cashu-test", provider: TEST_MINT, asset: "BTC", unit: "sat", address: "pay-1", expiresAt: Date.now() + 60_000,
      id: "review-1", payee: "peer", amount: 30, fee: 2, feeCap: 10, createdAt: 0, state: "pending" } as Review;
    renderApp(<PaymentReview review={review} wallet={Object.create(servicesPlatform!.wallet) as WalletPlatform} onClose={() => {}} />);
    expect(screen.getByTestId("review-approve")).toHaveClass("max-md:min-h-11");
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveClass("max-md:min-h-11");
    expect(screen.getByText("Payment details")).toHaveClass("max-md:min-h-11");
  });
});
