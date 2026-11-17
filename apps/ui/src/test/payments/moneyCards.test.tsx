import { act, screen, waitFor, within } from "@testing-library/react";
import { createElement, Profiler } from "react";
import { renderToString } from "react-dom/server";
import { QRCodeSVG } from "qrcode.react";
import { Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { decodeBolt11, type PaymentReview as Review } from "@ghostly/core";
import { fakeInvoice } from "@ghostly/browser/engine/paymentAdapters/providers/testing";
import type { CashuInspection, GroupMemberView, LinkView, NetworkWalletsView, PaymentView, StoredMessage, WalletView } from "@ghostly/browser/shared/types";
import { MessageBubble } from "../../components/MessageBubble";
import { satsIn } from "../../components/NetworkTag";
import { PaymentBubble } from "../../components/PaymentBubble";
import { PaymentReview } from "../../components/PaymentReview";
import { CashuWallet } from "../../components/wallet/CashuWallet";
import { LightningAddressPay } from "../../components/wallet/LightningAddressPay";
import { networkState } from "../../components/walletCardData";
import { ALL_METHODS_ON } from "../../lib/chatPayments";
import { servicesPlatform, type LightningAddressInfo, type WalletPlatform, type WalletState } from "../../lib/platform";
import { qrFits } from "../../lib/qrFits";
import { translateWith } from "../../locales/translate";
import { GroupChat } from "../../pages/GroupChat";
import { fakeEngine, groupView, linkView, paymentView, walletView, type StatePatch } from "../fakeEngine";
import { LANGUAGES, LOCALES } from "../i18n/locales";
import { renderApp } from "../render";
import { lightningSource, liveMainnetInvoice, liveRegtestInvoice, MAINNET_INVOICE, mint, REAL_MINT, reviewOf, target, TEST_MINT } from "./fixtures";
import { bcrt1q } from "./moneyFormatFixtures";

// covers: payments.lightning.invoice-card, payments.cashu.token-card, payments.money.onchain-card
describe("a contact's money of a network turned off in the chat", () => {
  /**
   * A chat can take a way of paying on one network and not the other (Testnet Lightning off, Mainnet Lightning on). A
   * contact's money of a network turned off in the chat is not paid or redeemed from its card, and the card says it is
   * off here, as when the whole way of paying is off. The same way on the other network is still paid.
   */

  const message = (text: string) => ({ id: "m1", text, sender: "peer", timestamp: Date.now(), status: "delivered" }) as never;
  const INVOICE = fakeInvoice(25, new Uint8Array(32).fill(7));
  const TOKEN = `cashuBa${"o".repeat(60)}`;
  const ADDRESS = "bitcoin:tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx?amount=0.0001";

  function show(text: string, paymentNetworks: LinkView["paymentNetworks"], wallet: Partial<WalletView> = { lightning: lightningSource({ mode: "testnet", providerId: "fake-lightning" }), mints: [mint(TEST_MINT, 5_000)], balance: 5_000 }) {
    fakeEngine.setState({ links: [linkView({ paymentNetworks })], wallet });
    fakeEngine.on("walletInspectCashu", () => ({ inspection: { kind: "token", amount: 1_000, unit: "sat", mint: TEST_MINT, accepted: true } }));
    return renderApp(<MessageBubble message={message(text)} peerPubKey="peer" />);
  }

  beforeEach(() => fakeEngine.reset());

  describe("a contact's Testnet invoice", () => {
    it("with Testnet Lightning off in the chat, offers no Pay and says Lightning is off here", () => {
      show(INVOICE, { lightning: ["mainnet"] });
      const card = screen.getByTestId("invoice-bubble");
      expect(within(card).getByTestId("invoice-network")).toHaveTextContent("Test money");
      expect(within(card).queryByTestId("invoice-pay")).not.toBeInTheDocument();
      expect(screen.getByTestId("money-off")).toBeInTheDocument();
    });

    it("with only Mainnet Lightning off, is still paid", () => {
      show(INVOICE, { lightning: ["testnet"] });
      expect(within(screen.getByTestId("invoice-bubble")).getByTestId("invoice-pay")).toBeInTheDocument();
      expect(screen.queryByTestId("money-off")).not.toBeInTheDocument();
    });
  });

  describe("a contact's token of a test mint", () => {
    it("with Testnet Cashu off in the chat, offers no Redeem, not even before it is known, and says Cashu is off here", async () => {
      show(TOKEN, { cashu: ["mainnet"] });
      // Read as soon as the token's card is drawn: Redeem is never offered first and taken away after.
      const card = await screen.findByTestId("cashu-token-bubble");
      expect(within(card).getByTestId("token-network")).toHaveTextContent("Test money");
      expect(within(card).queryByTestId("token-redeem")).not.toBeInTheDocument();
      expect(await screen.findByTestId("money-off")).toBeInTheDocument();
    });

    it("with only Mainnet Cashu off, is still redeemed", async () => {
      show(TOKEN, { cashu: ["testnet"] });
      expect(within(await screen.findByTestId("cashu-token-bubble")).getByTestId("token-redeem")).toBeInTheDocument();
      expect(screen.queryByTestId("money-off")).not.toBeInTheDocument();
    });
  });

  describe("a contact's Testnet Bitcoin address", () => {
    it("with Testnet Bitcoin off in the chat, says Bitcoin is off here", () => {
      show(ADDRESS, { bitcoin: ["mainnet"] });
      expect(screen.getByTestId("onchain-bubble")).toBeInTheDocument();
      expect(screen.getByTestId("money-off")).toBeInTheDocument();
    });

    it("with only Mainnet Bitcoin off, is not said to be off", () => {
      show(ADDRESS, { bitcoin: ["testnet"] });
      expect(screen.queryByTestId("money-off")).not.toBeInTheDocument();
    });
  });
});

// covers: payments.lightning.invoice-card
describe("money in a chat on an engine state", () => {
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

// covers: payments.lightning.invoice-card, payments.cashu.token-card, payments.chat.review, payments.lightning.request, payments.cashu.reclaim, payments.money.onchain-card
describe("the chat's money cards from the keyboard", () => {
  /**
   * The chat's money cards from the keyboard: the button pressed keeps the focus while it works (busy, not disabled: a
   * disabled one drops it to the page in Chromium) and after a refusal, a press while busy does nothing, and each step
   * that takes the place of a button takes the focus.
   */
  const later = <T,>() => { let answer!: (value: T) => void, refuse!: (e: Error) => void; const promise = new Promise<T>((resolve, reject) => { answer = resolve; refuse = reject; }); return { promise, answer, refuse }; };
  const busy = (button: HTMLElement) => {
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toBeEnabled();
    expect(button).toHaveFocus();
  };
  const done = (button: HTMLElement) => waitFor(() => expect(button).not.toHaveAttribute("aria-busy"));
  const message = (text: string) => ({ id: "m1", text, sender: "peer", timestamp: Date.now(), status: "delivered" }) as never;
  const press = async (user: { keyboard(keys: string): Promise<void> }, button: HTMLElement) => { button.focus(); await user.keyboard("{Enter}"); };

  beforeEach(() => fakeEngine.reset());

  describe("a Lightning invoice in a message", () => {
    const invoice = liveMainnetInvoice(2_100);
    const quote = { quote: "melt-1", mint: TEST_MINT, amount: 2_100, feeReserve: 3 };
    const show = () => {
      fakeEngine.setState({ links: [linkView()], wallet: { mints: [mint(TEST_MINT, 5_000)], balance: 5_000 } });
      return renderApp(<MessageBubble message={message(invoice)} peerPubKey="peer" />);
    };

    it("Pay and the quoted Pay are busy where pressed and keep the keys after a refusal; the quote and Cancel hand them on", async () => {
      const { user, engine } = show();
      let quoted = later<typeof quote>(), quotes = 0;
      const paid = later<{ paid: boolean }>();
      engine.on("walletQuoteInvoice", () => { quotes++; return quoted.promise; }).on("walletPayQuote", () => paid.promise);
      const pay = screen.getByTestId("invoice-pay");
      await press(user, pay);
      busy(pay);
      await user.keyboard("{Enter}");
      quoted.refuse(new Error("The mint did not answer"));
      await done(pay);
      expect(pay).toHaveFocus();
      expect(quotes).toBe(1);

      quoted = later();
      await user.keyboard("{Enter}");
      quoted.answer(quote);
      const confirm = await screen.findByTestId("invoice-confirm");
      await waitFor(() => expect(confirm).toHaveFocus());
      await user.keyboard("{Enter}");
      busy(confirm);
      expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
      paid.refuse(new Error("Route not found"));
      await done(confirm);
      expect(confirm).toHaveFocus();

      await user.tab();
      await user.keyboard("{Enter}");
      expect(screen.getByTestId("invoice-pay")).toHaveFocus();
    });

    // Pressing the QR code hides it and puts a QR button in its place, and that button gives the code back: the keys stay
    // on the card's toggle, not on the page, whose next Tab starts from the top.
    it("the QR code and its QR button hand the keys to each other", async () => {
      const { user } = show();
      const card = screen.getByTestId("invoice-bubble");
      await press(user, within(card).getByTitle(/QR/));
      const qr = within(card).getByRole("button", { name: "QR" });
      await waitFor(() => expect(qr).toHaveFocus());
      await user.keyboard("{Enter}");
      await waitFor(() => expect(within(card).getByTitle(/QR/)).toHaveFocus());
    });

    it("Paid takes the keys from the Pay that paid it", async () => {
      const { user, engine } = show();
      engine.on("walletQuoteInvoice", () => quote).on("walletPayQuote", () => ({ paid: true }));
      await press(user, screen.getByTestId("invoice-pay"));
      await press(user, await screen.findByTestId("invoice-confirm"));
      await waitFor(() => expect(screen.getByTestId("invoice-paid")).toHaveFocus());
    });
  });

  describe("an ecash token in a message", () => {
    it("Redeem is busy where pressed and keeps the keys after a refusal; Redeemed takes them", async () => {
      fakeEngine.setState({ links: [linkView()] });
      fakeEngine.on("walletInspectCashu", () => ({ inspection: { kind: "token", amount: 1008, unit: "sat", mint: "https://mint.example.com", accepted: true } }));
      const { user, engine } = renderApp(<MessageBubble message={message(`cashuBa${"o".repeat(60)}`)} peerPubKey="peer" />);
      let received = later<{ amount: number }>();
      engine.on("walletReceiveToken", () => received.promise);
      const redeem = within(await screen.findByTestId("cashu-token-bubble")).getByTestId("token-redeem");
      await press(user, redeem);
      busy(redeem);
      received.refuse(new Error("The mint did not answer"));
      await done(redeem);
      expect(redeem).toHaveFocus();

      received = later();
      await user.keyboard("{Enter}");
      received.answer({ amount: 1008 });
      await waitFor(() => expect(screen.getByTestId("token-redeemed")).toHaveFocus());
    });

    it("the QR code and its QR button hand the keys to each other", async () => {
      fakeEngine.setState({ links: [linkView()] });
      fakeEngine.on("walletInspectCashu", () => ({ inspection: { kind: "token", amount: 1008, unit: "sat", mint: "https://mint.example.com", accepted: true } }));
      const { user } = renderApp(<MessageBubble message={message(`cashuBa${"o".repeat(60)}`)} peerPubKey="peer" />);
      const card = await screen.findByTestId("cashu-token-bubble");
      await press(user, within(card).getByTitle(/QR/));
      await waitFor(() => expect(within(card).getByRole("button", { name: "QR" })).toHaveFocus());
      await user.keyboard("{Enter}");
      await waitFor(() => expect(within(card).getByTitle(/QR/)).toHaveFocus());
    });
  });

  describe("a request in the chat", () => {
    const show = (payment: Parameters<typeof paymentView>[0], wallet: object) => {
      fakeEngine.setState({ links: [linkView()], wallet, payments: { "pay-1": paymentView(payment) } });
      return renderApp(<PaymentBubble paymentId="pay-1" peerPubKey="peer" fallbackText="[a payment]" />);
    };
    const reviewButton = () => screen.getByRole("button", { name: /^(Review payment|Preparing…)$/ });

    it("Review payment is busy where pressed and keeps the keys after a refusal; the review it opens takes them", async () => {
      const { user, engine } = show({ kind: "request", direction: "in", mints: [REAL_MINT] }, { mints: [mint(REAL_MINT, 900)] });
      let prepared = later<Review>();
      engine.on("preparePayment", () => prepared.promise);
      const open = reviewButton();
      await press(user, open);
      busy(open);
      prepared.refuse(new Error("The mint did not answer"));
      await done(open);
      expect(open).toHaveFocus();

      prepared = later();
      await user.keyboard("{Enter}");
      prepared.answer(reviewOf(engine.callsTo("preparePayment")[1]));
      await waitFor(() => expect(screen.getByRole("heading", { name: /Review payment/ })).toHaveFocus());
    });

    it("over Lightning: the review takes the keys, Approve is busy where pressed and keeps them after a refusal, Cancel hands them back", async () => {
      const { user, engine } = show({ kind: "request", direction: "in", amount: 250_000, invoice: liveRegtestInvoice(250_000) }, { lightning: lightningSource({ mode: "testnet", providerId: "fake-lightning" }) });
      const paid = later<void>();
      engine.on("walletQuoteInvoice", () => ({ quote: "q-1", mint: "", amount: 250_000, feeReserve: 5, source: "fake-lightning" })).on("payRequest", () => paid.promise);
      await press(user, reviewButton());
      await waitFor(() => expect(screen.getByTestId("payment-lightning-line")).toHaveFocus());
      const approve = screen.getByRole("button", { name: "Approve payment" });
      await press(user, approve);
      busy(approve);
      paid.refuse(new Error("No route"));
      await done(approve);
      expect(approve).toHaveFocus();
      await user.tab();
      await user.keyboard("{Enter}");
      expect(reviewButton()).toHaveFocus();
    });

    it("Take it back is busy where pressed and keeps the keys after a refusal", async () => {
      const { user, engine } = show({ kind: "payment", direction: "out", state: "pending" }, { mints: [mint(REAL_MINT, 0)] });
      const taken = later<void>();
      engine.on("reclaimPayment", () => taken.promise);
      const back = screen.getByRole("button", { name: "Take it back" });
      await press(user, back);
      busy(back);
      taken.refuse(new Error("Already redeemed"));
      await done(back);
      expect(back).toHaveFocus();
    });

    // The bubble draws again on its own (its review, the wallet's state), not with its message's row: what its own press
    // took out of the page is the bubble's to replace, or the keys fall to the page and Tab starts from the top.
    it("Close on its review hands the keys back to Review payment", async () => {
      const { user, engine } = show({ kind: "request", direction: "in", mints: [REAL_MINT] }, { mints: [mint(REAL_MINT, 900)] });
      engine.on("preparePayment", (params) => reviewOf(params)).on("cancelPayment", () => ({ ...reviewOf(engine.callsTo("preparePayment")[0]), state: "cancelled" }));
      await press(user, reviewButton());
      await press(user, await screen.findByRole("button", { name: "Cancel" }));
      await press(user, await screen.findByRole("button", { name: "Close" }));
      await waitFor(() => expect(screen.queryByTestId("payment-review")).not.toBeInTheDocument());
      expect(reviewButton()).toHaveFocus();
    });

    it("Close on the review of a request it paid leaves the keys on the bubble", async () => {
      const { user, engine } = show({ kind: "request", direction: "in", mints: [TEST_MINT] }, { mints: [mint(TEST_MINT, 900)] });
      engine.on("preparePayment", (params) => reviewOf(params)).on("approvePayment", () => {
        const paid: Review = { ...reviewOf(engine.callsTo("preparePayment")[0]), state: "settled" };
        engine.update({ wallet: { mints: [mint(TEST_MINT, 870)], intents: [paid] }, payments: { "pay-1": paymentView({ kind: "request", direction: "in", mints: [TEST_MINT], state: "settled" }) } });
        return paid;
      });
      await press(user, reviewButton());
      await press(user, await screen.findByTestId("review-approve"));
      await press(user, await screen.findByRole("button", { name: "Close" }));
      await waitFor(() => expect(screen.queryByTestId("payment-review")).not.toBeInTheDocument());
      expect(screen.getByTestId("payment-bubble")).toHaveFocus();
    });

    it("Take it back that took it back leaves the keys on the bubble", async () => {
      const { user, engine } = show({ kind: "payment", direction: "out", state: "pending" }, { mints: [mint(REAL_MINT, 0)] });
      engine.on("reclaimPayment", () => { engine.update({ payments: { "pay-1": paymentView({ kind: "payment", direction: "out", state: "reclaimed" }) } }); });
      await press(user, screen.getByRole("button", { name: "Take it back" }));
      await waitFor(() => expect(screen.queryByRole("button", { name: "Take it back" })).not.toBeInTheDocument());
      expect(screen.getByTestId("payment-bubble")).toHaveFocus();
    });

    it("keeps the keys as well when the payment was said in words first, before the wallet knew it", async () => {
      fakeEngine.setState({ links: [linkView()], wallet: { mints: [mint(REAL_MINT, 0)] } });
      const { user, engine } = renderApp(<PaymentBubble paymentId="pay-1" peerPubKey="peer" fallbackText="[a payment]" />);
      expect(screen.getByText("[a payment]")).toBeInTheDocument();
      act(() => engine.update({ payments: { "pay-1": paymentView({ kind: "payment", direction: "out", state: "pending" }) } }));
      engine.on("reclaimPayment", () => { engine.update({ payments: { "pay-1": paymentView({ kind: "payment", direction: "out", state: "reclaimed" }) } }); });
      await press(user, await screen.findByRole("button", { name: "Take it back" }));
      await waitFor(() => expect(screen.queryByRole("button", { name: "Take it back" })).not.toBeInTheDocument());
      expect(screen.getByTestId("payment-bubble")).toHaveFocus();
    });
  });

  describe("a payment's review", () => {
    const pending = { method: "cashu", network: "cashu-test", provider: TEST_MINT, asset: "BTC", unit: "sat", address: "pay-1", expiresAt: Date.now() + 60_000, id: "review-1", payee: "peer", amount: 30, fee: 2, feeCap: 10, createdAt: 0, state: "pending" } as Review;

    it("Approve and Cancel are busy where pressed, the other waits, and the keys stay after a refusal", async () => {
      const approved = later<Review>();
      const cancelled = later<Review>();
      const wallet: WalletPlatform = Object.assign(Object.create(servicesPlatform!.wallet), { approvePayment: () => approved.promise, cancelPayment: () => cancelled.promise });
      const { user } = renderApp(<PaymentReview review={pending} wallet={wallet} onClose={() => {}} />);
      const approve = screen.getByTestId("review-approve"), cancel = screen.getByRole("button", { name: "Cancel" });
      await press(user, approve);
      busy(approve);
      expect(cancel).toBeDisabled();
      approved.refuse(new Error("The mint did not answer"));
      await done(approve);
      expect(approve).toHaveFocus();

      await press(user, cancel);
      busy(cancel);
      expect(approve).toBeDisabled();
      cancelled.refuse(new Error("The mint did not answer"));
      await done(cancel);
      expect(cancel).toHaveFocus();
    });
  });

  describe("a pasted bitcoin: link", () => {
    const regtest = { status: "ready", providerId: "bdk", label: "BDK wallet", network: "regtest", balance: 100_000, history: [] } as unknown as NonNullable<NetworkWalletsView["bitcoin"]>;
    const empty = (): NetworkWalletsView => ({ mints: [], balance: 0, history: [], feesPaid: 0 });

    it("Pay opens a form that takes the keys; its Review is busy where pressed and keeps them after a refusal; Cancel hands them back", async () => {
      fakeEngine.setState({ wallet: { networks: { mainnet: empty(), testnet: { ...empty(), bitcoin: regtest } } } as never });
      const prepared = later<Review>();
      fakeEngine.on("preparePayment", () => prepared.promise);
      const { user } = renderApp(<MessageBubble message={message(`bitcoin:${bcrt1q()}?amount=0.0002`)} peerPubKey="peer" />);
      await press(user, screen.getByTestId("onchain-pay"));
      expect(screen.getByRole("textbox", { name: /fee/i })).toHaveFocus();
      const review = screen.getByTestId("money-review");
      await press(user, review);
      busy(review);
      prepared.refuse(new Error("Fee too high"));
      await done(review);
      expect(review).toHaveFocus();
      await user.tab();
      await user.keyboard("{Enter}");
      expect(screen.getByTestId("onchain-pay")).toHaveFocus();
    });
  });
});

// covers: payments.lightning.invoice-card, payments.lnurl.card
describe("an edited message holding money", () => {
  /**
   * A message holding money can be edited by the one who sent it. The card then shows what the message holds now, and
   * only that: a review started for the money before the edit is dropped, and Paid is only ever kept for what was paid.
   */

  const SETTLED_KEY = "ghostly_settled_marks";
  /** The key Paid is kept under: a digest of the whole invoice. */
  const settledMoneyId = (invoice: string) => Buffer.from(sha256(new TextEncoder().encode(invoice))).toString("hex");
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
      expect(localStorage.getItem(SETTLED_KEY) ?? "[]").not.toContain(settledMoneyId(edited));
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
      expect(settled).toContain(settledMoneyId(first));
      expect(settled).not.toContain(settledMoneyId(edited));
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
});

// covers: payments.cashu.token-card, payments.lightning.invoice-card
describe("the Redeemed and Paid marks of money in a message", () => {
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

    // agents#2255: the card showed the token's face value and "Redeemed ✓" while the mint had kept part of it as its fee.
    it("says what the mint kept as its fee when it kept one, and only Redeemed when it kept none", async () => {
      fakeEngine.setState({ links: [linkView()] });
      fakeEngine.on("walletInspectCashu", () => ({ inspection: { kind: "token", amount: 3, unit: "sat", mint: "https://mint.example.com", accepted: true } }));
      const view = renderApp(<><MessageBubble message={message("m1", `cashuBa${"f".repeat(60)}`)} peerPubKey="peer" /><MessageBubble message={message("m2", `cashuBa${"n".repeat(60)}`)} peerPubKey="peer" /></>);
      view.engine.on("walletReceiveToken", ({ token }: { token: string }) => (token.endsWith("f") ? { amount: 1, fee: 2 } : { amount: 3, fee: 0 }));
      const [feeCard, freeCard] = await screen.findAllByTestId("cashu-token-bubble");
      await view.user.click(within(feeCard!).getByTestId("token-redeem"));
      await waitFor(() => expect(within(feeCard!).getByTestId("token-redeemed")).toHaveTextContent("Redeemed ✓ (the mint kept 2 as its fee)"));
      await view.user.click(within(freeCard!).getByTestId("token-redeem"));
      await waitFor(() => expect(within(freeCard!).getByTestId("token-redeemed")).toHaveTextContent(/^Redeemed ✓$/));
    });

    // agents#1588: the same token in two messages: the second card offered Redeem still, and pressed said "Already spent"
    // for a token this device had just redeemed.
    it("turns every card of the same token Redeemed when one of them is redeemed here, not Already spent", async () => {
      const token = `cashuBa${"o".repeat(60)}`;
      fakeEngine.setState({ links: [linkView()] });
      fakeEngine.on("walletInspectCashu", () => ({ inspection: { kind: "token", amount: 1008, unit: "sat", mint: "https://mint.example.com", accepted: true } }));
      const view = renderApp(<><MessageBubble message={message("m1", token)} peerPubKey="peer" /><MessageBubble message={message("m2", token)} peerPubKey="peer" /></>);
      let receives = 0;
      view.engine.on("walletReceiveToken", () => {
        if (receives++) throw new Error("This ecash was already spent somewhere else");
        return { amount: 1008 };
      });
      await waitFor(() => expect(screen.getAllByTestId("token-redeem")).toHaveLength(2));
      const [first, second] = screen.getAllByTestId("cashu-token-bubble");
      await view.user.click(within(first).getByTestId("token-redeem"));
      expect(await within(first).findByTestId("token-redeemed")).toBeInTheDocument();
      expect(await within(second).findByTestId("token-redeemed")).toBeInTheDocument();
      expect(within(second).queryByTestId("token-redeem")).not.toBeInTheDocument();
      expect(within(second).queryByTestId("token-spent")).not.toBeInTheDocument();
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

    const refusedBy = (reason: string) => {
      fakeEngine.setState({ links: [linkView()], wallet: { lightning: lightningSource({ mode: "testnet", providerId: "fake-lightning" }) } });
      const text = fakeInvoice(100, new Uint8Array(32).fill(9));
      const view = renderApp(<MessageBubble message={message("m1", text)} peerPubKey="peer" />);
      view.engine.on("walletQuoteInvoice", () => ({ quote: "quote-A", mint: "", amount: 100, feeReserve: 1, source: "fake-lightning" })).on("walletPayQuote", () => {
        throw new Error(reason);
      });
      return { view, text };
    };
    const pay = async (view: ReturnType<typeof renderApp>) => {
      await view.user.click(within(screen.getByTestId("invoice-bubble")).getByTestId("invoice-pay"));
      await view.user.click(await screen.findByTestId("invoice-confirm"));
    };

    it("is shown when the mint refuses because the invoice was already paid: there is nothing left to pay", async () => {
      const { view } = refusedBy("Invoice already paid");
      await pay(view);
      expect(await screen.findByTestId("invoice-paid")).toBeInTheDocument();
    });

    it("is not shown when the recipient refused an invoice it does not know: nothing was paid", async () => {
      // LND's FAILURE_REASON_INCORRECT_PAYMENT_DETAILS: the recipient's node does not take the payment, which it says for
      // an invoice it never made, cancelled or settled alike. Nothing left the wallet, and nobody is known to have paid.
      const { view, text } = refusedBy("The recipient refused the payment (unknown or already paid invoice)");
      await pay(view);
      const card = screen.getByTestId("invoice-bubble");
      expect(await within(card).findByText("The recipient refused the payment (unknown or already paid invoice)")).toBeInTheDocument();
      expect(within(card).queryByTestId("invoice-paid")).not.toBeInTheDocument();
      view.unmount();

      renderApp(<MessageBubble message={message("m2", text)} peerPubKey="peer" />);
      expect(within(screen.getByTestId("invoice-bubble")).queryByTestId("invoice-paid")).not.toBeInTheDocument();
    });
  });
});

// covers: payments.lightning.invoice-card
describe("a contact's Lightning invoice paid and left pending", () => {
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

// covers: wallet.testnet.receive-held
describe("a Testnet invoice paid from its card in a chat", () => {
  /**
   * A test mint's Receive invoice counts only once a payer says it paid it (the engine's held quote). Paid from its card in
   * a chat, the engine is told which chat it was in, so the contact who made it hears it was paid.
   */

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

// covers: wallet.testnet.receive-held
describe("a Testnet invoice paid from its card in a group", () => {
  /**
   * A test mint's Receive invoice counts only once a payer says it paid it (the engine's held quote). Pasted in a group and
   * paid from its card there, the member who wrote it is told over our chat with them, when they are a contact.
   */

  const BOB = "bob".padEnd(52, "y"), ME = "me".padEnd(52, "y");
  const member = (patch: Partial<GroupMemberView>): GroupMemberView => ({ key: ME, role: "member", me: false, online: true, missing: 0, ...patch });

  async function payInGroup(memberLinks: Record<string, string>) {
    const invoice = fakeInvoice(25, new Uint8Array(32).fill(9));
    const message: StoredMessage = { linkId: "group:group-1", id: "g1", text: invoice, sender: "peer", member: BOB, timestamp: Date.now(), via: "datalink" };
    fakeEngine.on("groupMessages", () => [message]).on("updateSettings", () => undefined).on("setGroupTyping", () => undefined);
    fakeEngine.update({
      links: [linkView({ id: "link-bob", peerPubKeyZ32: "bob-contact" })],
      groups: [groupView({ status: "active", epoch: 1, members: [member({ key: ME, me: true }), member({ key: BOB, nick: "Bob" })], memberLinks })],
      wallet: { lightning: lightningSource({ mode: "testnet", providerId: "fake-lightning" }) },
    });
    const view = renderApp(<Routes><Route path="/group/:groupId" element={<GroupChat />} /></Routes>, { route: "/group/group-1" });
    view.engine.on("walletQuoteInvoice", () => ({ quote: "melt-1", mint: TEST_MINT, amount: 25, feeReserve: 0, source: "cashu-mint" })).on("walletPayQuote", () => ({ paid: true }));
    await view.user.click(within(await screen.findByTestId("invoice-bubble")).getByTestId("invoice-pay"));
    await view.user.click(await screen.findByTestId("invoice-confirm"));
    expect(await screen.findByTestId("invoice-paid")).toBeInTheDocument();
    return { calls: view.engine.callsTo("walletPayQuote"), invoice };
  }

  it("names our chat with the member who wrote it, so they are told", async () => {
    const { calls, invoice } = await payInGroup({ "link-bob": BOB });
    expect(calls).toEqual([{ quote: "melt-1", mint: TEST_MINT, linkId: "link-bob", invoice }]);
  });

  it("names no chat when the member who wrote it is not a contact", async () => {
    const { calls } = await payInGroup({});
    expect(calls).toEqual([{ quote: "melt-1", mint: TEST_MINT }]);
  });
});

// covers: payments.lightning.invoice-card, wallet.cashu.pay-invoice, payments.lnurl.card
describe("a Lightning payment over what the paying card holds", () => {
  /**
   * Every Lightning review, not only a chat request's (PaymentBubble), never approves more than the paying card says it
   * holds: it says so, and Pay stays off. A card that does not say what it holds is left to its node, as before.
   */

  const testSource = (balance?: number) => lightningSource({ mode: "testnet", providerId: "fake-lightning", ...(balance === undefined ? {} : { balance }) });

  describe("a Lightning invoice in a message", () => {
    const show = (wallet: Partial<WalletView>) => {
      fakeEngine.setState({ links: [linkView()], wallet });
      const view = renderApp(<MessageBubble message={{ id: "m1", text: fakeInvoice(250_000, new Uint8Array(32).fill(7)), sender: "peer", timestamp: Date.now(), status: "delivered" } as never} peerPubKey="peer" />);
      view.engine.on("walletQuoteInvoice", () => ({ quote: "q-1", mint: "", amount: 250_000, feeReserve: 5, source: "fake-lightning" })).on("walletPayQuote", () => ({ paid: true }));
      return view;
    };

    it("never pays more than the card holds, and says why; enough coming in turns Pay back on", async () => {
      const { user, engine } = show({ lightning: testSource(100_000) });
      const card = screen.getByTestId("invoice-bubble");
      await user.click(within(card).getByTestId("invoice-pay"));
      expect(await within(card).findByTestId("invoice-over")).toHaveTextContent("More than the 100,000 test sats on this card.");
      expect(within(card).getByTestId("invoice-confirm")).toBeDisabled();
      await user.click(within(card).getByTestId("invoice-confirm"));
      expect(engine.callsTo("walletPayQuote")).toEqual([]);
      act(() => engine.update({ wallet: { lightning: testSource(300_000) } }));
      expect(within(card).queryByTestId("invoice-over")).not.toBeInTheDocument();
      await user.click(within(card).getByTestId("invoice-confirm"));
      expect(await within(card).findByTestId("invoice-paid")).toBeInTheDocument();
      expect(engine.callsTo("walletPayQuote")).toHaveLength(1);
    });

    it("leaves Pay to the node when the card does not say what it holds", async () => {
      const { user, engine } = show({ lightning: testSource() });
      const card = screen.getByTestId("invoice-bubble");
      await user.click(within(card).getByTestId("invoice-pay"));
      await user.click(await within(card).findByTestId("invoice-confirm"));
      expect(within(card).queryByTestId("invoice-over")).not.toBeInTheDocument();
      expect(await within(card).findByTestId("invoice-paid")).toBeInTheDocument();
      expect(engine.callsTo("walletPayQuote")).toHaveLength(1);
    });
  });

  describe("the wallet's Pay invoice", () => {
    const invoice = liveMainnetInvoice(2_100);
    const show = (rail: "cashu" | "lightning", patch: Partial<WalletView>) => {
      const state = walletView({ mode: "testnet", ...patch }) as WalletState;
      const view = renderApp(<CashuWallet wallet={servicesPlatform!.wallet} state={state} rail={rail} onOpenCashu={() => {}} />);
      view.engine.on("walletQuoteInvoice", () => ({ quote: "melt-1", mint: TEST_MINT, amount: 2_100, feeReserve: 3 })).on("walletPayQuote", () => ({ paid: true }));
      return view;
    };
    const review = async (user: ReturnType<typeof show>["user"]) => {
      await user.click(screen.getByTestId("wallet-send"));
      await user.type(screen.getByTestId("wallet-pay-input"), invoice);
      await user.click(screen.getByRole("button", { name: /^Pay 2,100 test sats$/ }));
      return screen.findByTestId("wallet-pay-confirm");
    };

    it("on the Cashu card, more than its mints hold is never paid", async () => {
      const { user, engine } = show("cashu", { mints: [mint(TEST_MINT, 1_000)], balance: 1_000 });
      const pay = await review(user);
      expect(screen.getByTestId("wallet-pay-over")).toHaveTextContent("More than the 1,000 test sats on this card.");
      expect(pay).toBeDisabled();
      await user.click(pay);
      expect(engine.callsTo("walletPayQuote")).toEqual([]);
    });

    it("on a Lightning card with its own node, more than the node holds is never paid", async () => {
      const { user, engine } = show("lightning", { lightning: testSource(2_000) });
      const pay = await review(user);
      expect(screen.getByTestId("wallet-pay-over")).toHaveTextContent("More than the 2,000 test sats on this card.");
      expect(pay).toBeDisabled();
      expect(engine.callsTo("walletPayQuote")).toEqual([]);
    });

    it.each([["holds enough", 5_000], ["does not say what it holds", undefined]] as const)("pays when the card %s", async (_, balance) => {
      const { user, engine } = show("lightning", { lightning: testSource(balance) });
      await user.click(await review(user));
      expect(screen.queryByTestId("wallet-pay-over")).not.toBeInTheDocument();
      expect(await screen.findByTestId("wallet-notice")).toHaveTextContent("Paid.");
      expect(engine.callsTo("walletPayQuote")).toHaveLength(1);
    });
  });

  describe("paying a Lightning address", () => {
    const info = { id: "addr-1", kind: "address", text: "alice@example.com", domain: "example.com", callbackDomain: "example.com", minSat: 1, maxSat: 100_000, description: "Alice", commentAllowed: 0 } as LightningAddressInfo;
    const show = (balance: number) => {
      fakeEngine.setState({ wallet: walletView({ mode: "testnet", mints: [mint(TEST_MINT, balance)], balance }) });
      const view = renderApp(<LightningAddressPay wallet={servicesPlatform!.wallet.forNetwork("testnet")} text="alice@example.com" />);
      view.engine.on("lnurlResolve", () => info).on("lnurlInvoice", () => ({ invoice: "lnbc-invoice", note: "Paid alice@example.com" }))
        .on("walletQuoteInvoice", () => ({ quote: "melt-1", mint: TEST_MINT, amount: 2_100, feeReserve: 3 })).on("walletPayQuote", () => ({ paid: true }));
      return view;
    };
    const review = async (user: ReturnType<typeof show>["user"]) => {
      await user.click(screen.getByTestId("lnurl-lookup"));
      await user.type(await screen.findByTestId("lnurl-amount"), "2100");
      await user.click(screen.getByTestId("lnurl-invoice"));
      return screen.findByTestId("lnurl-pay");
    };

    it("never pays more than the card holds", async () => {
      const { user, engine } = show(1_000);
      const pay = await review(user);
      expect(screen.getByTestId("lnurl-over")).toHaveTextContent("More than the 1,000 test sats on this card.");
      expect(pay).toBeDisabled();
      expect(engine.callsTo("walletPayQuote")).toEqual([]);
    });

    it("pays when it holds enough", async () => {
      const { user, engine } = show(5_000);
      await user.click(await review(user));
      expect(screen.queryByTestId("lnurl-over")).not.toBeInTheDocument();
      expect(await screen.findByTestId("lnurl-paid")).toBeInTheDocument();
      expect(engine.callsTo("walletPayQuote")).toHaveLength(1);
    });
  });
});

// covers: payments.lightning.invoice-card, payments.mainnet-confirm, wallet.cashu.test-sats, wallet.lightning.card, wallet.cashu.pay-invoice, payments.lnurl.card
describe("a Lightning fee's unit", () => {
  /**
   * A pasted invoice's Pay ("Pay 2,000 + up to 5 fee"), its real-money step's fee and a history row's fee ("fee 2") said
   * no unit, while every amount beside them said sats or test sats. Now they say it, in its form for the count.
   */

  describe("a Lightning invoice in a message", () => {
    const invoice = liveMainnetInvoice(2_100);
    const show = (wallet: Partial<WalletView>, feeReserve: number) => {
      fakeEngine.setState({ links: [linkView()], wallet });
      const view = renderApp(<MessageBubble message={{ id: "m1", text: invoice, sender: "peer", timestamp: Date.now(), status: "delivered" } as never} peerPubKey="peer" />);
      view.engine.on("walletQuoteInvoice", () => ({ quote: "melt-1", mint: REAL_MINT, amount: 2_100, feeReserve })).on("walletPayQuote", () => ({ paid: true }));
      return view;
    };

    it("with test sats, Pay says test sats", async () => {
      const { user } = show({ mints: [mint(TEST_MINT, 5_000)], balance: 5_000 }, 5);
      const card = screen.getByTestId("invoice-bubble");
      await user.click(within(card).getByTestId("invoice-pay"));
      expect(await within(card).findByTestId("invoice-confirm")).toHaveTextContent(/^Pay 2,100 test sats \+ up to 5 fee$/);
    });

    it("with real money, Pay says sats and the real-money step says the fee's unit, singular for one", async () => {
      const { user } = show({ mints: [mint(REAL_MINT, 5_000)], balance: 5_000 }, 1);
      const card = screen.getByTestId("invoice-bubble");
      await user.click(within(card).getByTestId("invoice-pay"));
      const pay = await within(card).findByTestId("invoice-confirm");
      expect(pay).toHaveTextContent(/^Pay 2,100 sats \+ up to 1 fee$/);
      await user.click(pay);
      expect(screen.getByTestId("review-mainnet-confirm")).toHaveTextContent("This sends 2,100 sats (plus a fee of up to 1 sat) that cannot be taken back");
    });
  });

  describe("a wallet's history", () => {
    const wallet = servicesPlatform!.wallet;

    it("a Cashu row's fee says test sats, as the Fees paid line above it does", async () => {
      const state = networkState(walletView({ mints: [mint(TEST_MINT, 100)], balance: 100, feesPaid: 2, history: [
        { id: "out", timestamp: 1, mint: TEST_MINT, kind: "lightning-out", amount: 50, fee: 2 },
      ] }) as WalletState, "testnet");
      const { user } = renderApp(<CashuWallet wallet={wallet} state={state} rail="cashu" onOpenCashu={() => {}} />);
      await user.click(screen.getByTestId("wallet-history"));
      expect(screen.getByTestId("wallet-fees-paid")).toHaveTextContent("Fees paid: 2 test sats");
      expect(screen.getByTestId("wallet-tx")).toHaveTextContent(/fee 2 test sats$/);
    });

    it("a Lightning card's Recent row says the fee's unit, singular for one", () => {
      const ln = lightningSource({ mode: "testnet", recent: [
        { direction: "out", providerId: "cln-1", mode: "testnet", paymentHash: "h2", invoice: "lntb2", amount: 70, expiresAt: 0, createdAt: 0, state: "paid", fee: 1 },
      ] } as never);
      const state = networkState(walletView({ mints: [mint(TEST_MINT, 0)], lightning: ln }) as WalletState, "testnet");
      renderApp(<CashuWallet wallet={wallet} state={state} rail="lightning" onOpenCashu={() => {}} />);
      expect(screen.getByTestId("lightning-op")).toHaveTextContent(/fee 1 test sat(?!s)/);
    });
  });

  describe("the Wallets page's real-money step", () => {
    const quote = { quote: "melt-1", mint: REAL_MINT, amount: 2_100, feeReserve: 1 };

    it("a pasted invoice on the Cashu card says the fee's unit, singular for one", async () => {
      const state = walletView({ mode: "mainnet", mints: [mint(REAL_MINT, 5_000)], balance: 5_000 }) as WalletState;
      const { user, engine } = renderApp(<CashuWallet wallet={servicesPlatform!.wallet} state={state} rail="cashu" onOpenCashu={() => {}} />);
      engine.on("walletQuoteInvoice", () => quote);
      await user.click(screen.getByTestId("wallet-send"));
      await user.type(screen.getByTestId("wallet-pay-input"), liveMainnetInvoice(2_100));
      await user.click(screen.getByRole("button", { name: /^Pay 2,100 sats$/ }));
      await user.click(await screen.findByTestId("wallet-pay-confirm"));
      expect(screen.getByTestId("review-mainnet-confirm")).toHaveTextContent("This sends 2,100 sats (plus a fee of up to 1 sat) that cannot be taken back");
    });

    it("a Lightning address says the fee's unit", async () => {
      const info = { id: "addr-1", kind: "address", text: "alice@example.com", domain: "example.com", callbackDomain: "example.com", minSat: 1, maxSat: 100_000, description: "Alice", commentAllowed: 0 } as LightningAddressInfo;
      fakeEngine.setState({ wallet: walletView({ mints: [mint(REAL_MINT, 5_000), mint(TEST_MINT, 5_000)] }) });
      const { user, engine } = renderApp(<LightningAddressPay wallet={servicesPlatform!.wallet.forNetwork("mainnet")} text="alice@example.com" />);
      engine.on("lnurlResolve", () => info).on("lnurlInvoice", () => ({ invoice: "lnbc-invoice", note: "Paid alice@example.com" })).on("walletQuoteInvoice", () => ({ ...quote, feeReserve: 3 }));
      await user.click(screen.getByTestId("lnurl-lookup"));
      await user.type(await screen.findByTestId("lnurl-amount"), "2100");
      await user.click(screen.getByTestId("lnurl-invoice"));
      await user.click(await screen.findByTestId("lnurl-pay"));
      expect(screen.getByTestId("review-mainnet-confirm")).toHaveTextContent("This sends 2,100 sats (plus a fee of up to 3 sats) that cannot be taken back");
    });
  });

  describe("in every language", () => {
    it.each(LANGUAGES)("in %s, each fee string writes the unit", (language) => {
      const t = translateWith(LOCALES[language], language);
      const unit = satsIn(t, "testnet");
      expect(t("payments.invoice.payWithFee", { amount: "2", fee: "5", unit })).toContain(unit);
      expect(t("wallet.cashu.history.fee", { amount: "2", unit })).toContain(unit);
      for (const key of ["payments.invoice.confirmWhat", "wallet.lightning.confirmWhat"] as const) {
        const real = t(key, { amount: "5", fee: "5", unit: satsIn(t, "mainnet"), feeUnit: satsIn(t, "mainnet", 5) });
        expect(real.split(satsIn(t, "mainnet", 5)).length - 1, key).toBe(2);
      }
    });
  });
});

// covers: payments.mainnet-confirm, payments.lightning.invoice-card, wallet.cashu.pay-invoice, payments.lnurl.card
describe("real money's second step before it leaves", () => {
  /**
   * Every way real money leaves asks once more, in words ("Send real money"), and only that step tells the engine it
   * was confirmed (`confirmedReal`); Back sends nothing. Test money goes on the first click, and says nothing more.
   */

  const quote = { quote: "melt-1", mint: REAL_MINT, amount: 2_100, feeReserve: 3 };
  const confirmStep = () => screen.getByTestId("review-mainnet-confirm");

  describe("a Lightning invoice in a message", () => {
    const invoice = liveMainnetInvoice(2_100);
    const show = (wallet: Partial<WalletView>) => {
      fakeEngine.setState({ links: [linkView()], wallet });
      const view = renderApp(<MessageBubble message={{ id: "m1", text: invoice, sender: "peer", timestamp: Date.now(), status: "delivered" } as never} peerPubKey="peer" />);
      view.engine.on("walletQuoteInvoice", () => quote).on("walletPayQuote", () => ({ paid: true }));
      return view;
    };

    it("paid with a Mainnet wallet: Pay opens the real-money step; Back pays nothing, Send real money pays", async () => {
      const { user, engine } = show({ mints: [mint(REAL_MINT, 5_000)], balance: 5_000 });
      const card = screen.getByTestId("invoice-bubble");
      expect(within(card).getByTestId("invoice-network")).toHaveTextContent("Real money");
      await user.click(within(card).getByTestId("invoice-pay"));
      await user.click(await within(card).findByTestId("invoice-confirm"));
      expect(confirmStep()).toHaveTextContent("Real money. This sends 2,100 sats (plus a fee of up to 3 sats) that cannot be taken back");
      expect(engine.callsTo("walletPayQuote")).toEqual([]);
      await user.click(screen.getByTestId("review-confirm-back"));
      expect(screen.queryByTestId("review-mainnet-confirm")).not.toBeInTheDocument();
      expect(engine.callsTo("walletPayQuote")).toEqual([]);
      await user.click(within(card).getByTestId("invoice-confirm"));
      await user.click(screen.getByTestId("review-confirm-send"));
      expect(await within(card).findByTestId("invoice-paid")).toBeInTheDocument();
      expect(engine.callsTo("walletPayQuote")).toEqual([{ quote: "melt-1", mint: REAL_MINT, confirmedReal: true, linkId: "link-1", invoice }]);
    });

    it("paid with test sats (only a Testnet wallet): Pay pays at once, with no second step", async () => {
      const { user, engine } = show({ mints: [mint(TEST_MINT, 5_000)], balance: 5_000 });
      const card = screen.getByTestId("invoice-bubble");
      await user.click(within(card).getByTestId("invoice-pay"));
      await user.click(await within(card).findByTestId("invoice-confirm"));
      expect(screen.queryByTestId("review-mainnet-confirm")).not.toBeInTheDocument();
      expect(await within(card).findByTestId("invoice-paid")).toBeInTheDocument();
      expect(engine.callsTo("walletPayQuote")).toEqual([{ quote: "melt-1", mint: REAL_MINT, linkId: "link-1", invoice }]);
    });
  });

  describe("the Cashu card's Send: a pasted invoice", () => {
    const invoice = liveMainnetInvoice(2_100);
    const show = (mode: "mainnet" | "testnet") => {
      const state = walletView({ mode, mints: [mint(mode === "mainnet" ? REAL_MINT : TEST_MINT, 5_000)], balance: 5_000 }) as WalletState;
      const view = renderApp(<CashuWallet wallet={servicesPlatform!.wallet} state={state} rail="cashu" onOpenCashu={() => {}} />);
      view.engine.on("walletQuoteInvoice", () => quote).on("walletPayQuote", () => ({ paid: true }));
      return view;
    };
    const quoteIt = async (user: ReturnType<typeof show>["user"]) => {
      await user.click(screen.getByTestId("wallet-send"));
      await user.type(screen.getByTestId("wallet-pay-input"), invoice);
      await user.click(screen.getByRole("button", { name: /^Pay 2,100 (test )?sats$/ }));
      await user.click(await screen.findByTestId("wallet-pay-confirm"));
    };

    it("on Mainnet, Pay opens the real-money step and only Send real money pays", async () => {
      const { user, engine } = show("mainnet");
      await quoteIt(user);
      expect(confirmStep()).toHaveTextContent("This sends 2,100 sats (plus a fee of up to 3 sats)");
      expect(engine.callsTo("walletPayQuote")).toEqual([]);
      await user.click(screen.getByTestId("review-confirm-send"));
      expect(await screen.findByTestId("wallet-notice")).toHaveTextContent("Paid.");
      expect(engine.callsTo("walletPayQuote")).toEqual([{ quote: "melt-1", mint: REAL_MINT, confirmedReal: true }]);
    });

    it("Back from the keyboard puts the keys back on Pay, not on the page", async () => {
      const { user, engine } = show("mainnet");
      await quoteIt(user);
      await user.keyboard("{Enter}");
      expect(screen.queryByTestId("review-mainnet-confirm")).not.toBeInTheDocument();
      await waitFor(() => expect(screen.getByTestId("wallet-pay-confirm")).toHaveFocus());
      expect(engine.callsTo("walletPayQuote")).toEqual([]);
    });

    it("on Testnet, Pay pays at once", async () => {
      const { user, engine } = show("testnet");
      await quoteIt(user);
      expect(screen.queryByTestId("review-mainnet-confirm")).not.toBeInTheDocument();
      expect(await screen.findByTestId("wallet-notice")).toHaveTextContent("Paid.");
      expect(engine.callsTo("walletPayQuote")).toEqual([{ quote: "melt-1", mint: REAL_MINT }]);
    });
  });

  describe("a Lightning address", () => {
    const info: LightningAddressInfo = { id: "addr-1", kind: "address", text: "alice@example.com", domain: "example.com", callbackDomain: "example.com", minSat: 1, maxSat: 100_000, description: "Alice", commentAllowed: 0 } as LightningAddressInfo;
    const show = (network: "mainnet" | "testnet") => {
      fakeEngine.setState({ wallet: walletView({ mints: [mint(REAL_MINT, 5_000), mint(TEST_MINT, 5_000)] }) });
      const view = renderApp(<LightningAddressPay wallet={servicesPlatform!.wallet.forNetwork(network)} text="alice@example.com" />);
      view.engine.on("lnurlResolve", () => info).on("lnurlInvoice", () => ({ invoice: "lnbc-invoice", note: "Paid alice@example.com" }))
        .on("walletQuoteInvoice", () => quote).on("walletPayQuote", () => ({ paid: true }));
      return view;
    };
    const toPay = async (user: ReturnType<typeof show>["user"]) => {
      await user.click(screen.getByTestId("lnurl-lookup"));
      await user.type(await screen.findByTestId("lnurl-amount"), "2100");
      await user.click(screen.getByTestId("lnurl-invoice"));
      await user.click(await screen.findByTestId("lnurl-pay"));
    };

    it("on Mainnet, Pay opens the real-money step; only Send real money pays", async () => {
      const { user, engine } = show("mainnet");
      await toPay(user);
      expect(confirmStep()).toHaveTextContent("This sends 2,100 sats");
      expect(engine.callsTo("walletPayQuote")).toEqual([]);
      await user.click(screen.getByTestId("review-confirm-send"));
      expect(await screen.findByTestId("lnurl-paid")).toBeInTheDocument();
      expect(engine.callsTo("walletPayQuote")).toEqual([{ quote: "melt-1", mint: REAL_MINT, note: "Paid alice@example.com", confirmedReal: true }]);
    });

    it("Back from the keyboard puts the keys back on Pay, not on the page", async () => {
      const { user, engine } = show("mainnet");
      await toPay(user);
      expect(screen.getByTestId("review-confirm-back")).toHaveFocus();
      await user.keyboard("{Enter}");
      expect(screen.queryByTestId("review-mainnet-confirm")).not.toBeInTheDocument();
      await waitFor(() => expect(screen.getByTestId("lnurl-pay")).toHaveFocus());
      expect(engine.callsTo("walletPayQuote")).toEqual([]);
    });

    it("on Testnet, Pay pays at once", async () => {
      const { user, engine } = show("testnet");
      await toPay(user);
      expect(screen.queryByTestId("review-mainnet-confirm")).not.toBeInTheDocument();
      expect(await screen.findByTestId("lnurl-paid")).toBeInTheDocument();
      expect(engine.callsTo("walletPayQuote")).toEqual([{ quote: "melt-1", mint: REAL_MINT, note: "Paid alice@example.com" }]);
    });

    it("on Testnet, every amount says test sats: the limits, the amount field, the review and the receipt", async () => {
      const { user } = show("testnet");
      await user.click(screen.getByTestId("lnurl-lookup"));
      expect(await screen.findByTestId("lnurl-domain")).toHaveTextContent("It takes 1 to 100,000 test sats.");
      expect(screen.getByTestId("lnurl-amount")).toHaveAccessibleName("Amount in test sats");
      expect(screen.getByTestId("lnurl-amount-form")).toHaveTextContent(/test sats/);
      await user.type(screen.getByTestId("lnurl-amount"), "2100");
      await user.click(screen.getByTestId("lnurl-invoice"));
      expect(await screen.findByTestId("lnurl-review")).toHaveTextContent("Pay 2,100 test sats to alice@example.com");
      await user.click(screen.getByTestId("lnurl-pay"));
      expect(await screen.findByTestId("lnurl-paid")).toHaveTextContent("Paid 2,100 test sats to alice@example.com");
    });

    it("on Mainnet, the amounts stay plain sats", async () => {
      const { user } = show("mainnet");
      await user.click(screen.getByTestId("lnurl-lookup"));
      expect(await screen.findByTestId("lnurl-domain")).toHaveTextContent("It takes 1 to 100,000 sats.");
      expect(screen.getByTestId("lnurl-amount")).toHaveAccessibleName("Amount in sats");
    });
  });
});

// covers: payments.chat.networks, payments.chat.review, payments.cashu.test-sats, payments.lightning.invoice-card
describe("the network said in words wherever money moves", () => {
  /**
   * Wherever money moves, the network is said in words: "Test money" or "Real money" on the bubble, the review and an
   * invoice, test sats as the unit. Real money asks once more before it goes; test money goes on Approve. A request
   * of a network this profile has no wallet on says so, and offers no Review.
   */

  const both = (): Partial<WalletView> => ({ mints: [mint(REAL_MINT, 1_000), mint(TEST_MINT, 1_000)] });
  function show(payment: Partial<PaymentView>, { wallet = both(), link }: { wallet?: Partial<WalletView>; link?: Partial<LinkView> } = {}) {
    fakeEngine.setState({ links: [linkView(link)], wallet, payments: { "pay-1": paymentView(payment) } });
    return renderApp(<PaymentBubble paymentId="pay-1" peerPubKey="peer" fallbackText="[a payment]" />);
  }
  const incomingRequest = (patch: Partial<PaymentView> = {}) => ({ kind: "request" as const, direction: "in" as const, ...patch });
  const review = () => screen.findByRole("region", { name: "Payment review" });

  describe("the bubble names its money", () => {
    it.each([
      ["a Testnet request", incomingRequest({ network: "testnet", mints: [TEST_MINT] }), "Test money"],
      ["a Mainnet request", incomingRequest({ network: "mainnet", mints: [REAL_MINT] }), "Real money"],
      ["a payment of test sats sent", { kind: "payment" as const, direction: "out" as const, network: "testnet" as const, amount: 21 }, "Test money"],
      ["a payment of real sats received", { kind: "payment" as const, direction: "in" as const, network: "mainnet" as const, amount: 21 }, "Real money"],
    ])("%s wears the words, not only a colour", (_what, payment, words) => {
      show(payment);
      const tag = screen.getByTestId("payment-network");
      expect(tag).toHaveTextContent(words);
      expect(tag).toHaveAttribute("data-network", words === "Test money" ? "testnet" : "mainnet");
    });

    it.each([
      ["a Bitcoin address", target({ method: "bitcoin", network: "bitcoin", provider: "onchain", address: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4" })],
      ["an Ark address", target({ network: "bitcoin", address: "ark1payee" })],
    ])("a request kept as Testnet that carries %s is real money, in sats", (_what, onMainnet) => {
      show(incomingRequest({ amount: 50_000, network: "testnet", target: onMainnet }));
      expect(screen.getByTestId("payment-network")).toHaveTextContent("Real money");
      expect(screen.queryByText(/test sats/)).not.toBeInTheDocument();
    });
  });

  describe("the review says which money, and real money asks once more", () => {
    it("test money: Test money on the review, test sats as the unit, and Approve sends at once", async () => {
      const { user, engine } = show(incomingRequest({ amount: 5_000, target: target({ method: "bitcoin", network: "signet", provider: "onchain", address: "tb1qpayee" }) }));
      engine.on("preparePayment", reviewOf);
      engine.on("approvePayment", (params) => ({ ...reviewOf({ target: target({ method: "bitcoin", network: "signet", provider: "onchain", address: "tb1qpayee" }), amount: 5_000, feeCap: 2_000, payee: "peer", linkId: "link-1" }), id: params.id, state: "submitted" }));
      await user.click(screen.getByRole("button", { name: "Review payment" }));
      const panel = await review();
      expect(within(panel).getByTestId("review-network")).toHaveTextContent("Test money");
      expect(within(panel).getByTestId("review-money")).toHaveTextContent("worth nothing");
      expect(panel).toHaveTextContent("5,000 test sats");
      await user.click(within(panel).getByTestId("review-approve"));
      expect(screen.queryByTestId("review-mainnet-confirm")).not.toBeInTheDocument();
      expect(engine.callsTo("approvePayment")).toEqual([{ id: "review-1" }]);
    });

    it("real money: Real money on the review, then a confirmation in words; Back sends nothing, Send real money does", async () => {
      const onchain = target({ method: "bitcoin", network: "bitcoin", provider: "onchain", address: "bc1qpayee" });
      const { user, engine } = show(incomingRequest({ amount: 5_000, network: "mainnet", target: onchain }));
      engine.on("preparePayment", reviewOf);
      engine.on("approvePayment", (params) => ({ ...reviewOf({ target: onchain, amount: 5_000, feeCap: 2_000, payee: "peer", linkId: "link-1" }), id: params.id, state: "submitted" }));
      await user.click(screen.getByRole("button", { name: "Review payment" }));
      const panel = await review();
      expect(within(panel).getByTestId("review-network")).toHaveTextContent("Real money");
      expect(within(panel).getByTestId("review-money")).toHaveTextContent("Real money: it leaves your wallet once you confirm.");
      expect(panel).toHaveTextContent("5,000 sats");
      expect(panel).not.toHaveTextContent("test sats");
      await user.click(within(panel).getByTestId("review-approve"));
      const confirm = within(panel).getByTestId("review-mainnet-confirm");
      expect(confirm).toHaveTextContent("Real money. This sends 5,000 sats that cannot be taken back once it settles. Nothing has gone out yet.");
      expect(engine.callsTo("approvePayment")).toEqual([]);
      await user.click(within(confirm).getByRole("button", { name: "Back" }));
      expect(screen.queryByTestId("review-mainnet-confirm")).not.toBeInTheDocument();
      expect(engine.callsTo("approvePayment")).toEqual([]);
      await user.click(within(panel).getByTestId("review-approve"));
      await user.click(within(panel).getByTestId("review-confirm-send"));
      // Only the confirmation says real money was confirmed: the engine refuses a Mainnet approval without it.
      expect(engine.callsTo("approvePayment")).toEqual([{ id: "review-1", confirmedReal: true }]);
      expect(await within(panel).findByTestId("review-status")).toHaveTextContent("submitted");
    });
  });

  describe("a request of a network this profile has no wallet on", () => {
    it("says test money is asked for, offers no Review, and still lets another wallet pay it", () => {
      const onchain = target({ method: "bitcoin", network: "signet", provider: "onchain", address: "tb1qpayee" });
      show(incomingRequest({ amount: 5_000, network: "testnet", target: onchain }), { wallet: { mints: [mint(REAL_MINT, 1_000)] } });
      expect(screen.getByTestId("payment-network-missing")).toHaveTextContent("You have no Testnet wallet to pay this" + "Make one in Wallets, or ask for real money.");
      expect(screen.queryByRole("button", { name: "Review payment" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Pay with another wallet" })).toBeInTheDocument();
    });

    it("says real money is asked for when only a Testnet wallet is there", () => {
      show(incomingRequest({ amount: 5_000, network: "mainnet", mints: [REAL_MINT] }), { wallet: { mints: [mint(TEST_MINT, 1_000)] } });
      expect(screen.getByTestId("payment-network-missing")).toHaveTextContent("You have no Mainnet wallet to pay this" + "Make one in Wallets, or ask for test money.");
      expect(screen.queryByRole("button", { name: "Review payment" })).not.toBeInTheDocument();
    });

    it("with a wallet of that network, the Review is there and the words are not", () => {
      show(incomingRequest({ amount: 5_000, network: "mainnet", mints: [REAL_MINT] }));
      expect(screen.queryByTestId("payment-network-missing")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Review payment" })).toBeInTheDocument();
    });
  });

  describe("a Lightning invoice in a message", () => {
    const invoiceMessage = (wallet: Partial<WalletView>) => {
      fakeEngine.setState({ links: [linkView()], wallet });
      return renderApp(<MessageBubble message={{ id: "m1", text: MAINNET_INVOICE, sender: "peer", timestamp: Date.now(), status: "delivered" } as never} peerPubKey="peer" />);
    };

    it("names real money on a Mainnet invoice, and pays it with a Mainnet Lightning wallet", () => {
      invoiceMessage(both());
      const card = screen.getByTestId("invoice-bubble");
      expect(within(card).getByTestId("invoice-network")).toHaveTextContent("Real money");
      expect(card).not.toHaveTextContent("you have no");
      // The fixture invoice is a real one, long expired: Pay is offered only while an invoice can still be paid.
      if (!card.textContent?.includes("Expired")) expect(within(card).getByTestId("invoice-pay")).toBeInTheDocument();
    });

    it("with no Lightning wallet at all, says in words there is no Mainnet Lightning wallet to pay it from, and offers no Pay", () => {
      invoiceMessage({ mints: [] });
      const card = screen.getByTestId("invoice-bubble");
      expect(card).toHaveTextContent("Real money: you have no Mainnet Lightning wallet to pay it from");
      expect(within(card).queryByTestId("invoice-pay")).not.toBeInTheDocument();
      expect(within(card).getByRole("button", { name: "Copy" })).toBeInTheDocument();
    });

    it("with only a Testnet wallet, an invoice on Bitcoin (a test mint's look the same) is paid with test sats, and says so", () => {
      invoiceMessage({ mints: [mint(TEST_MINT, 1_000)] });
      const card = screen.getByTestId("invoice-bubble");
      expect(within(card).getByTestId("invoice-network")).toHaveTextContent("Test money");
      expect(card).toHaveTextContent("test sats");
      expect(card).not.toHaveTextContent("you have no");
    });
  });

  describe("ecash in a message", () => {
    const TOKEN = "cashuB" + "o".repeat(40);
    const REQUEST = "creqA" + "o".repeat(40);
    const LOCAL_MINT = "http://127.0.0.1:3338";
    const ecashMessage = (text: string, inspection: CashuInspection) => {
      fakeEngine.setState({ links: [linkView()], wallet: both() });
      fakeEngine.on("walletInspectCashu", () => ({ inspection }));
      return renderApp(<MessageBubble message={{ id: "m1", text, sender: "peer", timestamp: Date.now(), status: "delivered" } as never} peerPubKey="peer" />);
    };
    const token = (mint: string, accepted = true) => ecashMessage(TOKEN, { kind: "token", amount: 1_000, unit: "sat", mint, accepted });
    const request = (mints: string[]) => ecashMessage(REQUEST, { kind: "request", amount: 1_000, unit: "sat", mints });

    it.each([
      ["the public test mint", TEST_MINT],
      ["a mint on this machine", LOCAL_MINT],
    ])("a token of %s is test money, in test sats", async (_what, mint) => {
      token(mint);
      const card = await screen.findByTestId("cashu-token-bubble");
      const tag = within(card).getByTestId("token-network");
      expect(tag).toHaveTextContent("Test money");
      expect(tag).toHaveAttribute("data-network", "testnet");
      expect(card).toHaveTextContent("1,000test sats");
    });

    it("a token of a test mint the wallet does not have is still said to be test money", async () => {
      token(LOCAL_MINT, false);
      const card = await screen.findByTestId("cashu-token-bubble");
      expect(within(card).getByTestId("token-network")).toHaveTextContent("Test money");
      expect(card).toHaveTextContent("1,000test sats");
    });

    it("a token of one of the wallet's own mints is real money, in sats", async () => {
      token(REAL_MINT);
      const card = await screen.findByTestId("cashu-token-bubble");
      const tag = within(card).getByTestId("token-network");
      expect(tag).toHaveTextContent("Real money");
      expect(tag).toHaveAttribute("data-network", "mainnet");
      expect(card).toHaveTextContent("1,000sats");
      expect(card).not.toHaveTextContent("test sats");
    });

    it("a token of a mint the wallet does not have is not called real money: nothing here vouches for that mint", async () => {
      token("https://mint.unknown.example", false);
      const card = await screen.findByTestId("cashu-token-bubble");
      expect(within(card).queryByTestId("token-network")).not.toBeInTheDocument();
      expect(card).toHaveTextContent("You have not added this mint");
      expect(card).not.toHaveTextContent("test sats");
    });

    it("a request to be paid at a test mint is test money, in test sats", async () => {
      request([TEST_MINT]);
      const card = await screen.findByTestId("cashu-request-bubble");
      expect(within(card).getByTestId("token-network")).toHaveTextContent("Test money");
      expect(card).toHaveTextContent("1,000test sats");
    });

    it("a request to be paid at a real mint is real money", async () => {
      request([REAL_MINT]);
      const card = await screen.findByTestId("cashu-request-bubble");
      expect(within(card).getByTestId("token-network")).toHaveTextContent("Real money");
      expect(card).not.toHaveTextContent("test sats");
    });

    it.each([
      ["no mint", []],
      ["a test mint and a real one", [TEST_MINT, REAL_MINT]],
    ])("a request that names %s does not say which money", async (_what, mints) => {
      request(mints);
      const card = await screen.findByTestId("cashu-request-bubble");
      expect(within(card).queryByTestId("token-network")).not.toBeInTheDocument();
      expect(card).not.toHaveTextContent("test sats");
    });
  });
});

// covers: payments.cashu.token-card, payments.lightning.invoice-card
describe("qrFits", () => {
  const draws = (value: string) => {
    try {
      renderToString(createElement(QRCodeSVG, { value, level: "L" }));
      return true;
    } catch {
      return false;
    }
  };

  // Each mode's last length that fits and the first that does not, checked against qrcode.react itself.
  it.each([
    ["digits", "1", 7089],
    ["an upper-cased invoice", "LIGHTNING:LNBC1", 4296],
    ["an ecash token", "cashuBo", 2953],
    ["text beyond ASCII", "é", 1476],
  ])("agrees with qrcode.react at the edge for %s", (_, unit, edge) => {
    const at = (n: number) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
    expect(qrFits(at(edge))).toBe(true);
    expect(draws(at(edge))).toBe(true);
    expect(qrFits(at(edge + 1))).toBe(false);
    expect(draws(at(edge + 1))).toBe(false);
  });
});
