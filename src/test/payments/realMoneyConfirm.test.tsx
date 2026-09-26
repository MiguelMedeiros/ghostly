import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { WalletView } from "@ghostly/browser/shared/types";
import { MessageBubble } from "../../components/MessageBubble";
import { CashuWallet } from "../../components/wallet/CashuWallet";
import { LightningAddressPay } from "../../components/wallet/LightningAddressPay";
import { servicesPlatform, type LightningAddressInfo, type WalletState } from "../../lib/platform";
import { fakeEngine, linkView, walletView } from "../fakeEngine";
import { renderApp } from "../render";
import { liveMainnetInvoice, mint, REAL_MINT, TEST_MINT } from "./fixtures";

// covers: payments.mainnet-confirm, payments.lightning.invoice-card, wallet.cashu.pay-invoice, payments.lnurl.card

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
    const { user, engine } = show({ mints: [mint(REAL_MINT, 5_000)] });
    const card = screen.getByTestId("invoice-bubble");
    expect(within(card).getByTestId("invoice-network")).toHaveTextContent("Real money");
    await user.click(within(card).getByTestId("invoice-pay"));
    await user.click(await within(card).findByTestId("invoice-confirm"));
    expect(confirmStep()).toHaveTextContent("Real money. This sends 2,100 sats (plus a fee of up to 3) that cannot be taken back");
    expect(engine.callsTo("walletPayQuote")).toEqual([]);
    await user.click(screen.getByTestId("review-confirm-back"));
    expect(screen.queryByTestId("review-mainnet-confirm")).not.toBeInTheDocument();
    expect(engine.callsTo("walletPayQuote")).toEqual([]);
    await user.click(within(card).getByTestId("invoice-confirm"));
    await user.click(screen.getByTestId("review-confirm-send"));
    expect(await within(card).findByTestId("invoice-paid")).toBeInTheDocument();
    expect(engine.callsTo("walletPayQuote")).toEqual([{ quote: "melt-1", mint: REAL_MINT, confirmedReal: true }]);
  });

  it("paid with test sats (only a Testnet wallet): Pay pays at once, with no second step", async () => {
    const { user, engine } = show({ mints: [mint(TEST_MINT, 5_000)] });
    const card = screen.getByTestId("invoice-bubble");
    await user.click(within(card).getByTestId("invoice-pay"));
    await user.click(await within(card).findByTestId("invoice-confirm"));
    expect(screen.queryByTestId("review-mainnet-confirm")).not.toBeInTheDocument();
    expect(await within(card).findByTestId("invoice-paid")).toBeInTheDocument();
    expect(engine.callsTo("walletPayQuote")).toEqual([{ quote: "melt-1", mint: REAL_MINT }]);
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
    await user.click(screen.getByRole("button", { name: "Pay 2,100 sats" }));
    await user.click(await screen.findByTestId("wallet-pay-confirm"));
  };

  it("on Mainnet, Pay opens the real-money step and only Send real money pays", async () => {
    const { user, engine } = show("mainnet");
    await quoteIt(user);
    expect(confirmStep()).toHaveTextContent("This sends 2,100 sats (plus a fee of up to 3)");
    expect(engine.callsTo("walletPayQuote")).toEqual([]);
    await user.click(screen.getByTestId("review-confirm-send"));
    expect(await screen.findByText("Paid.")).toBeInTheDocument();
    expect(engine.callsTo("walletPayQuote")).toEqual([{ quote: "melt-1", mint: REAL_MINT, confirmedReal: true }]);
  });

  it("on Testnet, Pay pays at once", async () => {
    const { user, engine } = show("testnet");
    await quoteIt(user);
    expect(screen.queryByTestId("review-mainnet-confirm")).not.toBeInTheDocument();
    expect(await screen.findByText("Paid.")).toBeInTheDocument();
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

  it("on Testnet, Pay pays at once", async () => {
    const { user, engine } = show("testnet");
    await toPay(user);
    expect(screen.queryByTestId("review-mainnet-confirm")).not.toBeInTheDocument();
    expect(await screen.findByTestId("lnurl-paid")).toBeInTheDocument();
    expect(engine.callsTo("walletPayQuote")).toEqual([{ quote: "melt-1", mint: REAL_MINT, note: "Paid alice@example.com" }]);
  });
});
