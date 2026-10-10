import { screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import type { PaymentReview as Review } from "@ghostly/core";
import { PaymentReview } from "../../components/PaymentReview";
import { servicesPlatform, type WalletPlatform } from "../../lib/platform";
import { TEST_MINT } from "./fixtures";
import { renderApp } from "../render";

// covers: payments.chat.review

/**
 * A payment's review takes the place of the button that opened it (a request bubble's Review payment), and after
 * Approve its row of buttons changes: the focus goes to its title each time, not to the page, so the keys go on from
 * the review and a screen reader says what it is.
 */
const pending: Review = {
  method: "cashu", network: "cashu-test", provider: TEST_MINT, asset: "BTC", unit: "sat", address: "pay-1", expiresAt: Date.now() + 60_000,
  id: "review-1", payee: "peer", amount: 30, fee: 2, feeCap: 10, createdAt: 0, state: "pending",
} as Review;
const wallet: WalletPlatform = Object.assign(Object.create(servicesPlatform!.wallet), {
  approvePayment: async () => ({ ...pending, state: "settled" }),
  cancelPayment: async () => ({ ...pending, state: "cancelled" }),
});

/** A bubble's Review payment button, which the review replaces once pressed. */
function Bubble() {
  const [open, setOpen] = useState(false);
  return open ? <PaymentReview review={pending} wallet={wallet} onClose={() => setOpen(false)} /> : <button type="button" onClick={() => setOpen(true)}>Review payment</button>;
}

describe("the focus around a payment review", () => {
  it("goes to the review it opened, then stays with it after Approve", async () => {
    const { user } = renderApp(<Bubble />);
    await user.tab();
    expect(screen.getByRole("button", { name: "Review payment" })).toHaveFocus();
    await user.keyboard("{Enter}");
    const title = screen.getByRole("heading", { name: /Review/ });
    expect(title).toHaveFocus();
    // On from the title: its details, then Approve.
    await user.tab();
    await user.tab();
    expect(screen.getByTestId("review-approve")).toHaveFocus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByTestId("review-approve")).not.toBeInTheDocument());
    expect(screen.getByRole("heading")).toHaveFocus();
  });

  it("is never taken from where it is: after Cancel it stays on the button in its place", async () => {
    const { user } = renderApp(<Bubble />);
    await user.tab();
    await user.keyboard("{Enter}");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
  });
});
