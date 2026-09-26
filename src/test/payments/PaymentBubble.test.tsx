import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { decodeBolt11 } from "@ghostly/core";
import type { LinkView, PaymentView, WalletView } from "@ghostly/browser/shared/types";
import { PaymentBubble } from "../../components/PaymentBubble";
import { fakeEngine, linkView, paymentView } from "../fakeEngine";
import { renderApp } from "../render";
import { lightningSource, MAINNET_INVOICE, mint, REAL_MINT, REGTEST_INVOICE, reviewOf, SIGNET_INVOICE, target, TEST_MINT, TESTNET_INVOICE } from "./fixtures";
import { choose } from "../select";

// covers: payments.chat.review, payments.chat.method-off, payments.cashu.request, payments.cashu.reclaim, payments.cashu.test-sats, payments.lightning.request, payments.bitcoin.send, payments.usdt.send, payments.external, payments.chat.networks

const ALL_ON = { cashu: true, lightning: true, arkade: true, bark: true, spark: true, bitcoin: true, usdt: true, fedimint: true };

/** The bubble of payment "pay-1" in the chat with "peer". */
function show(payment: Partial<PaymentView>, { wallet, link }: { wallet?: Partial<WalletView>; link?: Partial<LinkView> } = {}) {
  fakeEngine.setState({ links: [linkView(link)], wallet, payments: { "pay-1": paymentView(payment) } });
  return renderApp(<PaymentBubble paymentId="pay-1" peerPubKey="peer" fallbackText="[a payment]" />);
}
/** A request from the contact, still to be paid. */
const incomingRequest = (patch: Partial<PaymentView> = {}) => ({ kind: "request" as const, direction: "in" as const, ...patch });

const status = () => screen.getByTestId("payment-state");
const payButton = () => screen.getByRole("button", { name: "Review payment" });

it("shows the message's own text for a payment the wallet does not know", () => {
  fakeEngine.setState({ links: [linkView()] });
  renderApp(<PaymentBubble paymentId="missing" peerPubKey="peer" fallbackText="[a payment]" />);
  expect(screen.getByText("[a payment]")).toBeInTheDocument();
  expect(screen.queryByTestId("payment-bubble")).not.toBeInTheDocument();
});

describe("what the bubble says", () => {
  it.each([
    ["request", "out", "You requested"],
    ["request", "in", "Requests"],
    ["payment", "out", "You sent"],
    ["payment", "in", "Sent you"],
  ] as const)("titles a %s going %s “%s”", (kind, direction, title) => {
    show({ kind, direction });
    expect(screen.getByText(title)).toBeInTheDocument();
  });

  it.each([
    ["payment", "pending", "Waiting for your contact…"],
    ["payment", "settled", "Received"],
    ["payment", "failed", "Failed"],
    ["payment", "reclaimed", "Taken back"],
    ["request", "pending", "Waiting for payment"],
    ["request", "settled", "Paid"],
    ["request", "failed", "Failed"],
  ] as const)("says a %s that is %s is “%s”", (kind, state, label) => {
    show({ kind, state, direction: "out" });
    expect(status()).toHaveTextContent(label);
  });

  it("says a Lightning payment is in flight, and offers nothing to pay it again", () => {
    show(incomingRequest({ lightningPending: true, invoice: MAINNET_INVOICE, amount: 2_100 }));
    expect(status()).toHaveTextContent("Lightning payment pending…");
    expect(screen.queryByRole("button", { name: "Review payment" })).not.toBeInTheDocument();
  });

  it("says an on-chain payment waits for a confirmation", () => {
    show({ kind: "payment", direction: "in", state: "pending", target: target({ method: "bitcoin", network: "bitcoin", provider: "onchain" }) });
    expect(status()).toHaveTextContent("Waiting for a confirmation…");
    expect(screen.getByText("Bitcoin on-chain · bitcoin")).toBeInTheDocument();
  });

  it("adds why a payment failed", () => {
    show({ kind: "payment", direction: "in", state: "failed", error: "Mint unreachable" });
    expect(status()).toHaveTextContent("Failed · Mint unreachable");
  });

  it("drops an old error once the payment settled", () => {
    show({ kind: "payment", direction: "in", state: "settled", error: "Mint unreachable" });
    expect(status()).toHaveTextContent(/^Received$/);
  });

  it("shows the memo", () => {
    show({ memo: "for the pizza" });
    expect(screen.getByText("for the pizza")).toBeInTheDocument();
  });

  it("shows a USDT amount with its decimals and asset", () => {
    show({ amount: 1_500_000, target: target({ method: "usdt", network: "sepolia", asset: "TEST-USDT", unit: "token-base", decimals: 6 }) });
    expect(screen.getByText("1.5")).toBeInTheDocument();
    expect(screen.getByText("TEST-USDT")).toBeInTheDocument();
    expect(screen.getByText("USDT · sepolia")).toBeInTheDocument();
  });
});

describe("test sats", () => {
  // The unit beside the amount: a contact must not pass test sats off as money.
  const unit = () => screen.getByText(/^(test )?sats$/);

  it.each([
    ["an Ark payment on signet", { target: target({ method: "arkade", network: "signet" }) }, "test sats"],
    ["an Ark payment on Bitcoin", { target: target({ method: "arkade", network: "bitcoin" }) }, "sats"],
    ["a Bark payment on signet", { target: target({ method: "bark", network: "signet" }) }, "test sats"],
    ["an on-chain payment on regtest", { target: target({ method: "bitcoin", network: "regtest", provider: "onchain" }) }, "test sats"],
    ["an on-chain payment on Bitcoin", { target: target({ method: "bitcoin", network: "bitcoin", provider: "onchain" }) }, "sats"],
    ["Cashu to the test network", { target: target({ method: "cashu", network: "cashu-test", provider: TEST_MINT }) }, "test sats"],
    ["Cashu on Bitcoin", { target: target({ method: "cashu", network: "bitcoin", provider: REAL_MINT }) }, "sats"],
    ["ecash from the public test mint", { mint: TEST_MINT }, "test sats"],
    ["ecash from a mint on this machine", { mint: "http://localhost:3338" }, "test sats"],
    ["ecash from a real mint", { mint: REAL_MINT }, "sats"],
    ["a request payable only at test mints", { kind: "request" as const, mints: [TEST_MINT, "http://127.0.0.1:3338"] }, "test sats"],
    ["a request payable at a real mint too", { kind: "request" as const, mints: [TEST_MINT, REAL_MINT] }, "sats"],
    ["an invoice-only request on testnet", { kind: "request" as const, invoice: TESTNET_INVOICE }, "test sats"],
    ["an invoice-only request on signet", { kind: "request" as const, invoice: SIGNET_INVOICE }, "test sats"],
    ["an invoice-only request on regtest", { kind: "request" as const, invoice: REGTEST_INVOICE }, "test sats"],
    ["an invoice-only request on Bitcoin", { kind: "request" as const, invoice: MAINNET_INVOICE }, "sats"],
  ])("counts %s in %s", (_, payment, expected) => {
    show({ direction: "out", ...payment });
    expect(unit()).toHaveTextContent(new RegExp(`^${expected}$`));
  });

  it("uses invoices that decode as the networks they claim", () => {
    // The fixtures are crafted (fixtures.ts): make sure they are what the tests above take them for.
    expect([TESTNET_INVOICE, SIGNET_INVOICE, REGTEST_INVOICE, MAINNET_INVOICE].map((i) => decodeBolt11(i)?.network)).toEqual(["testnet", "signet", "regtest", "bitcoin"]);
  });
});

describe("paying a request with Cashu", () => {
  it("reviews the payment from the mint both sides share, on that mint's network", async () => {
    const { user, engine } = show(incomingRequest({ mints: [REAL_MINT, "https://other.example"] }), { wallet: { mints: [mint(REAL_MINT, 900)] } });
    engine.on("preparePayment", reviewOf);
    const picker = screen.getByRole("combobox", { name: "Cashu mint" });
    expect(picker).toHaveAttribute("data-value", REAL_MINT);
    expect(picker).toHaveTextContent(`${REAL_MINT} 900 sats`);
    await user.click(payButton());
    expect(await screen.findByRole("region", { name: "Payment review" })).toBeInTheDocument();
    expect(engine.callsTo("preparePayment")).toEqual([{
      target: { method: "cashu", network: "bitcoin", provider: REAL_MINT, asset: "BTC", unit: "sat", address: "pay-1", expiresAt: expect.any(Number) },
      amount: 21, feeCap: 10, payee: "peer", linkId: "link-1", requestId: "pay-1", network: "mainnet",
    }]);
    // One review at a time.
    expect(payButton()).toBeDisabled();
  });

  it("pays from the test mint on the Cashu test network, through the Testnet wallet", async () => {
    const { user, engine } = show(incomingRequest({ mints: [TEST_MINT] }), { wallet: { mints: [mint(TEST_MINT, 900)] } });
    engine.on("preparePayment", reviewOf);
    await user.click(payButton());
    await screen.findByRole("region", { name: "Payment review" });
    expect(engine.callsTo("preparePayment")[0]).toMatchObject({ network: "testnet", target: { network: "cashu-test", provider: TEST_MINT } });
  });

  it("pays a request on the network it says, from that network's mints only", async () => {
    // Both networks have a mint the request names: the request is a Testnet one, so the test mint pays it.
    const { user, engine } = show(incomingRequest({ network: "testnet", mints: [REAL_MINT, TEST_MINT] }), { wallet: { mints: [mint(REAL_MINT, 900), mint(TEST_MINT, 900)] } });
    engine.on("preparePayment", reviewOf);
    const picker = screen.getByRole("combobox", { name: "Cashu mint" });
    expect(picker).toHaveAttribute("data-value", TEST_MINT);
    await user.click(payButton());
    await screen.findByRole("region", { name: "Payment review" });
    expect(engine.callsTo("preparePayment")[0]).toMatchObject({ network: "testnet", target: { network: "cashu-test", provider: TEST_MINT } });
  });

  it("cannot pay a Testnet request from a Mainnet mint, even one it names", () => {
    show(incomingRequest({ network: "testnet", mints: [REAL_MINT] }), { wallet: { mints: [mint(REAL_MINT, 900)] } });
    expect(screen.getByRole("combobox", { name: "Cashu mint" })).toHaveTextContent("No shared configured mint");
    expect(payButton()).toBeDisabled();
  });

  it("pays from the mint picked, under the fee typed", async () => {
    const other = "https://other.example";
    const { user, engine } = show(incomingRequest({ mints: [REAL_MINT, other] }), { wallet: { mints: [mint(REAL_MINT, 900), mint(other, 50)] } });
    engine.on("preparePayment", reviewOf);
    await choose(user, screen.getByRole("combobox", { name: "Cashu mint" }), other);
    const fee = screen.getByRole("textbox", { name: "Maximum fee (sats)" });
    await user.clear(fee);
    await user.type(fee, "5x");
    expect(fee).toHaveValue("5");
    await user.click(payButton());
    await screen.findByRole("region", { name: "Payment review" });
    expect(engine.callsTo("preparePayment")[0]).toMatchObject({ target: { provider: other }, feeCap: 5 });
  });

  it("cannot review a request with no mint in common and no invoice", () => {
    show(incomingRequest({ mints: ["https://other.example"] }), { wallet: { mints: [mint(REAL_MINT, 900)] } });
    const picker = screen.getByRole("combobox", { name: "Cashu mint" });
    expect(picker).toHaveTextContent("No shared configured mint");
    expect(picker).toBeDisabled();
    expect(payButton()).toBeDisabled();
  });

  it("shows why the payment could not be prepared", async () => {
    const { user, engine } = show(incomingRequest({ mints: [REAL_MINT] }), { wallet: { mints: [mint(REAL_MINT, 900)] } });
    engine.on("preparePayment", () => { throw new Error("Not enough at that mint"); });
    await user.click(payButton());
    expect(await screen.findByText("Not enough at that mint")).toBeInTheDocument();
    expect(payButton()).toBeEnabled();
  });

  it("offers a failed request to be paid again", () => {
    show(incomingRequest({ state: "failed", mints: [REAL_MINT] }), { wallet: { mints: [mint(REAL_MINT, 900)] } });
    expect(payButton()).toBeEnabled();
  });

  it("offers nothing to pay on a request that is paid, or on the requests I sent", () => {
    const { unmount } = show(incomingRequest({ state: "settled", mints: [REAL_MINT] }), { wallet: { mints: [mint(REAL_MINT, 900)] } });
    expect(screen.queryByRole("button", { name: "Review payment" })).not.toBeInTheDocument();
    unmount();
    show({ kind: "request", direction: "out", mints: [REAL_MINT] }, { wallet: { mints: [mint(REAL_MINT, 900)] } });
    expect(screen.queryByRole("button", { name: "Review payment" })).not.toBeInTheDocument();
  });
});

describe("paying a request on other rails", () => {
  it("reviews an on-chain request under the on-chain fee ceiling, on the network of its chain", async () => {
    const onchain = target({ method: "bitcoin", network: "signet", provider: "onchain", address: "tb1qpayee" });
    const { user, engine } = show(incomingRequest({ amount: 5_000, target: onchain }));
    engine.on("preparePayment", reviewOf);
    expect(screen.queryByRole("combobox", { name: "Cashu mint" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Maximum fee (sats)" })).toHaveValue("2000");
    await user.click(payButton());
    await screen.findByRole("region", { name: "Payment review" });
    // A signet address: the Testnet wallet pays it.
    expect(engine.callsTo("preparePayment")).toEqual([{ target: onchain, amount: 5_000, feeCap: 2_000, payee: "peer", linkId: "link-1", requestId: "pay-1", network: "testnet" }]);
  });

  it("caps a USDT payment's gas in ETH", async () => {
    const token = target({ method: "usdt", network: "sepolia", asset: "TEST-USDT", unit: "token-base", decimals: 6 });
    const { user, engine } = show(incomingRequest({ amount: 1_000_000, target: token }));
    engine.on("preparePayment", reviewOf);
    expect(screen.getByRole("textbox", { name: "Maximum gas (ETH)" })).toHaveValue("0.001");
    await user.click(payButton());
    await screen.findByRole("region", { name: "Payment review" });
    expect(engine.callsTo("preparePayment")[0]).toMatchObject({ feeCap: 10 ** 15, network: "testnet" });
  });
});

describe("a way of paying that is off in this chat", () => {
  it("keeps a Cashu request readable but offers nothing to pay it with", () => {
    show(incomingRequest({ mints: [REAL_MINT], invoice: MAINNET_INVOICE }), { wallet: { mints: [mint(REAL_MINT, 900)] }, link: { paymentMethods: { ...ALL_ON, cashu: false, lightning: false } } });
    expect(screen.getByTestId("payment-off")).toHaveTextContent("This way of paying is off in this chat.");
    expect(screen.queryByRole("button", { name: "Review payment" })).not.toBeInTheDocument();
  });

  it("goes by the request's own rail", () => {
    show(incomingRequest({ target: target({ method: "arkade" }) }), { link: { paymentMethods: { ...ALL_ON, arkade: false } } });
    expect(screen.getByTestId("payment-off")).toBeInTheDocument();
  });

  it("still pays when only another rail is off", () => {
    show(incomingRequest({ target: target({ method: "arkade" }) }), { link: { paymentMethods: { ...ALL_ON, bark: false } } });
    expect(screen.queryByTestId("payment-off")).not.toBeInTheDocument();
    expect(payButton()).toBeEnabled();
  });
});

describe("paying a request's invoice over Lightning", () => {
  // No mint in common: the invoice is what can be paid, through the Lightning source.
  const lightningRequest = () => incomingRequest({ amount: 2_100, invoice: MAINNET_INVOICE, mints: ["https://other.example"] });
  const quote = (patch = {}) => ({ quote: "q-1", mint: "", amount: 2_100, feeReserve: 5, source: "cln-1", ...patch });

  it("shows what the Mainnet Lightning source would spend, then pays with the fee ceiling on Approve", async () => {
    const { user, engine } = show(lightningRequest(), { wallet: { lightning: lightningSource({ providerId: "cln-1", alias: "My node" }) } });
    engine.on("walletQuoteInvoice", () => quote()).on("payRequest", () => undefined);
    expect(screen.queryByRole("combobox", { name: "Cashu mint" })).not.toBeInTheDocument();
    // 3% of the amount, as the engine pays requests under.
    expect(screen.getByRole("textbox", { name: "Maximum fee (sats)" })).toHaveValue("63");
    await user.click(payButton());
    expect(engine.callsTo("walletQuoteInvoice")).toEqual([{ invoice: MAINNET_INVOICE, via: undefined, network: "mainnet" }]);
    const review = await screen.findByTestId("payment-review");
    expect(review).toHaveTextContent("Pay 2,100 sats over Lightning");
    expect(review).toHaveTextContent("Through My node · fee up to 5 sats");
    expect(payButton()).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Approve payment" }));
    expect(engine.callsTo("payRequest")).toEqual([{ linkId: "link-1", paymentId: "pay-1", via: "lightning", maxFee: 63, network: "mainnet" }]);
    await expect.poll(() => screen.queryByTestId("payment-review")).toBeNull();
  });

  it("says the Cashu mints pay when the quote names no source", async () => {
    const { user, engine } = show(lightningRequest());
    engine.on("walletQuoteInvoice", () => quote({ source: undefined }));
    await user.click(payButton());
    expect(await screen.findByTestId("payment-review")).toHaveTextContent("Through the Cashu mints · fee up to 5 sats");
  });

  it("pays nothing on Cancel", async () => {
    const { user, engine } = show(lightningRequest());
    engine.on("walletQuoteInvoice", () => quote());
    await user.click(payButton());
    await screen.findByTestId("payment-review");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByTestId("payment-review")).not.toBeInTheDocument();
    expect(engine.callsTo("payRequest")).toEqual([]);
  });

  it("goes over Lightning when Cashu is off in this chat, even with a mint in common", async () => {
    const { user, engine } = show(incomingRequest({ amount: 2_100, invoice: MAINNET_INVOICE, mints: [REAL_MINT] }), {
      wallet: { mints: [mint(REAL_MINT, 9_000)] }, link: { paymentMethods: { ...ALL_ON, cashu: false } },
    });
    engine.on("walletQuoteInvoice", () => quote());
    await user.click(payButton());
    expect(await screen.findByTestId("payment-review")).toHaveTextContent("over Lightning");
    expect(engine.callsTo("preparePayment")).toEqual([]);
  });

  it("says test sats for a regtest invoice, and quotes it on the Testnet wallet", async () => {
    const { user, engine } = show(incomingRequest({ amount: 250_000, invoice: REGTEST_INVOICE }));
    engine.on("walletQuoteInvoice", () => quote({ amount: 250_000 }));
    await user.click(payButton());
    expect(await screen.findByTestId("payment-review")).toHaveTextContent("Pay 250,000 test sats over Lightning");
    expect(engine.callsTo("walletQuoteInvoice")).toEqual([{ invoice: REGTEST_INVOICE, via: undefined, network: "testnet" }]);
  });

  it("shows the Testnet Lightning source for a Testnet request, not the Mainnet one", async () => {
    // One source per network: the review names the one of the request's network.
    const { user, engine } = show(incomingRequest({ amount: 250_000, invoice: REGTEST_INVOICE }), { wallet: { lightning: lightningSource({ mode: "testnet", providerId: "cln-test", alias: "Test node" }) } });
    engine.on("walletQuoteInvoice", () => quote({ amount: 250_000, source: "cln-test" })).on("payRequest", () => undefined);
    await user.click(payButton());
    expect(await screen.findByTestId("payment-review")).toHaveTextContent("Through Test node");
    await user.click(screen.getByRole("button", { name: "Approve payment" }));
    expect(engine.callsTo("payRequest")).toEqual([expect.objectContaining({ paymentId: "pay-1", via: "lightning", network: "testnet" })]);
  });

  it("refuses an invoice for another amount than the one requested", async () => {
    const { user, engine } = show(lightningRequest());
    engine.on("walletQuoteInvoice", () => quote({ amount: 2_000 }));
    await user.click(payButton());
    expect(await screen.findByText("The invoice does not match the requested amount")).toBeInTheDocument();
    expect(screen.queryByTestId("payment-review")).not.toBeInTheDocument();
  });

  it("refuses a fee above the ceiling", async () => {
    const { user, engine } = show(lightningRequest());
    engine.on("walletQuoteInvoice", () => quote({ feeReserve: 100 }));
    await user.click(payButton());
    expect(await screen.findByText("The Lightning fee (up to 100 sats) is above your maximum")).toBeInTheDocument();
  });
});

describe("taking ecash back", () => {
  it("takes back ecash the contact has not picked up", async () => {
    const { user, engine } = show({ kind: "payment", direction: "out", state: "pending" });
    engine.on("reclaimPayment", () => undefined);
    await user.click(screen.getByRole("button", { name: "Take it back" }));
    expect(engine.callsTo("reclaimPayment")).toEqual([{ paymentId: "pay-1" }]);
  });

  it("shows why it could not be taken back", async () => {
    const { user, engine } = show({ kind: "payment", direction: "out", state: "failed", target: target({ method: "cashu", network: "bitcoin", provider: REAL_MINT }) });
    engine.on("reclaimPayment", () => { throw new Error("Already redeemed"); });
    await user.click(screen.getByRole("button", { name: "Take it back" }));
    expect(await screen.findByText("Already redeemed")).toBeInTheDocument();
  });

  it.each([
    ["ecash that arrived", { direction: "in" as const }],
    ["ecash already picked up", { state: "settled" as const }],
    ["an Ark payment", { target: target({ method: "arkade" }) }],
  ])("offers nothing to take back for %s", (_, patch) => {
    show({ kind: "payment", direction: "out", state: "pending", ...patch });
    expect(screen.queryByRole("button", { name: "Take it back" })).not.toBeInTheDocument();
  });
});

describe("paying with another wallet", () => {
  it("shows the invoice to scan or copy, and hides it again", async () => {
    const { user } = show(incomingRequest({ amount: 2_100, invoice: MAINNET_INVOICE }));
    const toggle = screen.getByRole("button", { name: "Pay with another wallet" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveTextContent("Hide");
    expect(screen.getByText(MAINNET_INVOICE)).toBeInTheDocument();
    expect(screen.getByText(/Paid from any Lightning wallet/)).toBeInTheDocument();
    await user.click(toggle);
    expect(screen.queryByText(MAINNET_INVOICE)).not.toBeInTheDocument();
  });

  it("shows an on-chain request's address, paid after a confirmation", async () => {
    const { user } = show(incomingRequest({ target: target({ method: "bitcoin", network: "signet", provider: "onchain", address: "tb1qpayee" }) }));
    await user.click(screen.getByRole("button", { name: "Pay with another wallet" }));
    expect(screen.getByText("tb1qpayee")).toBeInTheDocument();
    expect(screen.getByText(/Paid from any Bitcoin wallet.*after one confirmation/)).toBeInTheDocument();
  });

  it("has nothing to show for an ecash-only request", () => {
    show(incomingRequest({ mints: [REAL_MINT] }), { wallet: { mints: [mint(REAL_MINT, 900)] } });
    expect(screen.queryByRole("button", { name: "Pay with another wallet" })).not.toBeInTheDocument();
  });
});
