import { act, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { WalletView } from "@ghostly/browser/shared/types";
import { MessageBubble } from "../../components/MessageBubble";
import { CashuWallet } from "../../components/wallet/CashuWallet";
import { LightningAddressPay } from "../../components/wallet/LightningAddressPay";
import { servicesPlatform, type LightningAddressInfo, type WalletState } from "../../lib/platform";
import { fakeEngine, linkView, walletView } from "../fakeEngine";
import { renderApp } from "../render";
import { lightningSource, liveMainnetInvoice, mint, REGTEST_INVOICE, TEST_MINT } from "./fixtures";

// covers: payments.lightning.invoice-card, wallet.cashu.pay-invoice, payments.lnurl.card

/**
 * Every Lightning review, not only a chat request's (PaymentBubble), never approves more than the paying card says it
 * holds: it says so, and Pay stays off. A card that does not say what it holds is left to its node, as before.
 */

const testSource = (balance?: number) => lightningSource({ mode: "testnet", providerId: "fake-lightning", ...(balance === undefined ? {} : { balance }) });

describe("a Lightning invoice in a message", () => {
  const show = (wallet: Partial<WalletView>) => {
    fakeEngine.setState({ links: [linkView()], wallet });
    const view = renderApp(<MessageBubble message={{ id: "m1", text: REGTEST_INVOICE, sender: "peer", timestamp: Date.now(), status: "delivered" } as never} peerPubKey="peer" />);
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

  it("pays when the card holds enough, or does not say", async () => {
    for (const lightning of [testSource(5_000), testSource()]) {
      const { user, engine, unmount } = show("lightning", { lightning });
      await user.click(await review(user));
      expect(screen.queryByTestId("wallet-pay-over")).not.toBeInTheDocument();
      expect(await screen.findByText("Paid.")).toBeInTheDocument();
      expect(engine.callsTo("walletPayQuote")).toHaveLength(1);
      unmount();
    }
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
