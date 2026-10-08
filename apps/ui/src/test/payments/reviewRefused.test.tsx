import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { PaymentReview as Review } from "@ghostly/core";
import { PaymentReview } from "../../components/PaymentReview";
import { servicesPlatform } from "../../lib/platform";
import { fakeEngine, linkView } from "../fakeEngine";
import { TEST_MINT } from "./fixtures";
import { renderApp, type AppRenderOptions } from "../render";

// covers: payments.chat.refused, payments.chat.review

/**
 * A reviewed Cashu send the contact refused (a group request another member paid first): its ecash came back through a
 * swap at the mint, which kept a fee. The review says exactly what came back, not "The sats came back" as if all did,
 * and why some stayed with the mint is behind the ⓘ.
 */
const wallet = servicesPlatform!.wallet;
const refused = (patch: Partial<Review>): Review => ({
  method: "cashu", network: "cashu-test", provider: TEST_MINT, asset: "BTC", unit: "sat", address: "pay-1", expiresAt: Date.now() + 60_000,
  id: "review-1", payee: "peer", amount: 100, fee: 2, feeCap: 10, createdAt: 0, state: "failed", ...patch,
} as Review);
const show = (review: Review, language?: AppRenderOptions["language"]) => {
  fakeEngine.setState({ links: [linkView()], wallet: { intents: [review] } });
  return renderApp(<PaymentReview review={review} wallet={wallet} onClose={() => {}} />, language ? { language } : undefined);
};

describe("a refused send whose ecash came back", () => {
  it("says what came back and what the mint kept, with the why behind the ⓘ", async () => {
    const { user } = show(refused({ error: "Refused: Already paid by another member of the group. 98 sats came back; the mint kept 2 as its fee.", returned: { amount: 98, fee: 2 } }));
    expect(screen.getByTestId("review-error")).toHaveTextContent(/^The payment was refused(?:Already paid by another member of the group\. 98 sats came back; the mint kept 2\.)$/);
    expect(screen.queryByTestId("review-returned-text")).not.toBeInTheDocument();
    const info = screen.getByTestId("review-returned-info");
    expect(info).toHaveAttribute("aria-expanded", "false");
    await user.click(info);
    expect(info).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("review-returned-text")).toHaveTextContent("Taking ecash back is a swap at the mint, and the mint keeps a small fee for each swap: 2 test sats this time.");
  });

  it("says it in the app's language", () => {
    show(refused({ error: "Refused: Already paid by another member of the group. 98 sats came back; the mint kept 2 as its fee.", returned: { amount: 98, fee: 2 } }), "pt");
    expect(screen.getByTestId("review-error")).toHaveTextContent("O pagamento foi recusado" + "Já foi pago por outro membro do grupo. 98 sats voltaram; o mint ficou com 2.");
  });

  it("has nothing behind an ⓘ when all of it came back, or when what came back is not known", () => {
    show(refused({ error: "Refused: Already paid by another member of the group. All 100 sats came back.", returned: { amount: 100, fee: 0 } }));
    expect(screen.getByTestId("review-error")).toHaveTextContent("All 100 sats came back.");
    expect(screen.queryByTestId("review-returned-info")).not.toBeInTheDocument();
  });
});
