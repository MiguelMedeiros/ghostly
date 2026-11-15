import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeInvoice } from "@ghostly/browser/engine/paymentAdapters/providers/testing";
import { DEFAULT_MINTS, TEST_MINTS } from "@ghostly/browser/shared/mints";
import { engineText } from "@ghostly/core";
import { PayExternally } from "../../components/PayExternally";
import { PaymentBubble } from "../../components/PaymentBubble";
import { CashuWallet } from "../../components/wallet/CashuWallet";
import { LightningAddressPay } from "../../components/wallet/LightningAddressPay";
import { networkState } from "../../components/walletCardData";
import { servicesPlatform, type LightningAddressInfo, type WalletNetwork, type WalletPlatform, type WalletState } from "../../lib/platform";
import { fakeEngine, linkView, paymentView, walletView } from "../fakeEngine";
import { REGTEST_INVOICE, lightningSource, liveMainnetInvoice, mint, REAL_MINT, TEST_MINT } from "../payments/fixtures";
import { renderApp } from "../render";

// covers: wallet.cashu.receive-lightning, wallet.cashu.pay-invoice, payments.mainnet-confirm, wallet.instances.remove
describe("the Cashu card keeps the keyboard's place while it works", () => {
  /**
   * The Cashu card from the keyboard: the button pressed keeps the focus while it works (busy, not disabled: a disabled
   * one drops it to the page in Chromium) and after a refusal. A press while busy does nothing.
   */
  const TEST_MINT = TEST_MINTS[0];
  const OTHER = "https://other.example";
  const later = <T,>() => { let answer!: (value: T) => void, refuse!: (e: Error) => void; const promise = new Promise<T>((resolve, reject) => { answer = resolve; refuse = reject; }); return { promise, answer, refuse }; };
  const show = (methods: Partial<WalletPlatform>, network: "testnet" | "mainnet" = "testnet") => {
    const mints = network === "testnet" ? [mint(TEST_MINT, 5_000)] : [mint(REAL_MINT, 5_000), mint(OTHER, 0)];
    const state = networkState(walletView({ mode: network, mints, balance: 5_000 }) as WalletState, network);
    const wallet: WalletPlatform = Object.assign(Object.create(servicesPlatform!.wallet), methods);
    return renderApp(<CashuWallet wallet={wallet} state={state} rail="cashu" onOpenCashu={() => {}} />);
  };
  const busy = (button: HTMLElement) => {
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toBeEnabled();
    expect(button).toHaveFocus();
  };

  it("Create invoice: busy where it was pressed, and still there when the mint refuses", async () => {
    const asked = later<never>();
    let calls = 0;
    const { user } = show({ receiveLightning: () => { calls++; return asked.promise; } });
    await user.type(screen.getByTestId("wallet-receive-amount"), "21");
    const create = screen.getByTestId("wallet-create-invoice");
    create.focus();
    await user.keyboard("{Enter}");
    busy(create);
    await user.keyboard("{Enter}");
    asked.refuse(new Error("The mint did not answer"));
    expect(await screen.findByTestId("wallet-error")).toBeInTheDocument();
    expect(create).toHaveFocus();
    expect(create).not.toHaveAttribute("aria-busy");
    expect(calls).toBe(1);
  });

  it("Send's Pay, on Testnet: busy where it was pressed", async () => {
    const paid = later<boolean>();
    let calls = 0;
    const { user } = show({ quoteInvoice: async () => ({ quote: "q-1", mint: TEST_MINT, amount: 5, feeReserve: 1 }), payQuote: () => { calls++; return paid.promise; } });
    await user.click(screen.getByRole("tab", { name: "Send" }));
    await user.click(screen.getByTestId("wallet-pay-input"));
    await user.paste(REGTEST_INVOICE);
    const quoteIt = screen.getByRole("button", { name: /^Pay/ });
    quoteIt.focus();
    await user.keyboard("{Enter}");
    const pay = await screen.findByTestId("wallet-pay-confirm");
    pay.focus();
    await user.keyboard("{Enter}");
    busy(pay);
    await user.keyboard("{Enter}");
    paid.answer(true);
    expect(await screen.findByTestId("wallet-notice")).toHaveTextContent("Paid.");
    expect(calls).toBe(1);
  });

  it("Send real money, on Mainnet: busy where it was pressed, and still there when the mint refuses", async () => {
    const paid = later<boolean>();
    let calls = 0;
    const { user } = show({ quoteInvoice: async () => ({ quote: "q-1", mint: REAL_MINT, amount: 2_100, feeReserve: 3 }), payQuote: () => { calls++; return paid.promise; } }, "mainnet");
    await user.click(screen.getByRole("tab", { name: "Send" }));
    await user.click(screen.getByTestId("wallet-pay-input"));
    await user.paste(liveMainnetInvoice(2_100));
    await user.click(screen.getByRole("button", { name: /^Pay 2,100 sats$/ }));
    await user.click(await screen.findByTestId("wallet-pay-confirm"));
    const send = screen.getByTestId("review-confirm-send");
    send.focus();
    await user.keyboard("{Enter}");
    busy(send);
    await user.keyboard("{Enter}");
    paid.refuse(new Error("Route not found"));
    expect(await screen.findByTestId("wallet-error")).toBeInTheDocument();
    expect(send).toHaveFocus();
    expect(send).not.toHaveAttribute("aria-busy");
    expect(calls).toBe(1);
  });

  it("Add: busy where it was pressed, then the emptied address field takes the keys", async () => {
    const added = later<void>();
    const { user } = show({ addMint: () => added.promise });
    await user.type(screen.getByTestId("wallet-mint-url"), "https://mint.example.org");
    const add = screen.getByTestId("wallet-add-mint");
    add.focus();
    await user.keyboard("{Enter}");
    busy(add);
    added.answer();
    await waitFor(() => expect(screen.getByTestId("wallet-mint-url")).toHaveFocus());
    expect(screen.getByTestId("wallet-mint-url")).toHaveValue("");
  });

  it("removing a mint: Remove there is busy where it was pressed; Cancel goes back to the mint's Remove", async () => {
    const removed = later<void>();
    const { user } = show({ removeMint: () => removed.promise }, "mainnet");
    const row = () => screen.getAllByTestId("mint-row").find((r) => r.textContent?.includes("other.example"))!;
    const remove = within(row()).getByTestId("mint-remove");
    remove.focus();
    await user.keyboard("{Enter}");
    await user.click(screen.getByTestId("mint-remove-cancel"));
    expect(screen.queryByTestId("mint-remove-confirm")).not.toBeInTheDocument();
    expect(remove).toHaveFocus();

    await user.keyboard("{Enter}");
    const yes = screen.getByTestId("mint-remove-yes");
    yes.focus();
    await user.keyboard("{Enter}");
    busy(yes);
    removed.answer();
    await waitFor(() => expect(screen.queryByTestId("mint-remove-confirm")).not.toBeInTheDocument());
    expect(screen.getByTestId("wallet-mint-url")).toHaveFocus();
  });
});

// covers: wallet.cashu.mint.add
describe("the Cashu card answers Add and Copy backup where they were pressed", () => {
  /**
   * On a phone the Cashu card is one long column: what Add (a mint) and Copy backup answer is shown by the button that
   * was pressed, not above the Mints section, where it is drawn off the screen (a phone's keyboard up, or the page
   * scrolled down to Settings). The copied backup's line is said aloud too.
   */
  const show = (methods: Partial<WalletPlatform>) => {
    const state = networkState(walletView({ mode: "testnet", mints: [mint(TEST_MINTS[0], 5_000)], balance: 5_000 }) as WalletState, "testnet");
    const wallet: WalletPlatform = Object.assign(Object.create(servicesPlatform!.wallet), methods);
    return renderApp(<CashuWallet wallet={wallet} state={state} rail="cashu" onOpenCashu={() => {}} />);
  };

  it("a refused mint is said in the Mints section, by its field", async () => {
    const { user } = show({ addMint: async () => { throw new Error("Mints must use https"); } });
    await user.type(screen.getByTestId("wallet-mint-url"), "http://mint.example{Enter}");
    const error = await screen.findByTestId("wallet-error");
    expect(error).toHaveTextContent("Mints must use https");
    expect(within(screen.getByTestId("wallet-mints")).getByTestId("wallet-error")).toBe(error);
  });

  it("a copied backup is said below Copy backup, in a live region", async () => {
    const { user } = show({ exportTokens: async () => [{ token: "cashuBtoken", mint: TEST_MINTS[0], amount: 5_000 }] as never });
    await user.click(screen.getByRole("button", { name: "Copy backup" }));
    const notice = await screen.findByTestId("wallet-notice");
    expect(notice).toHaveTextContent("Backup copied.");
    expect(within(screen.getByTestId("wallet-backup")).getByTestId("wallet-notice")).toBe(notice);
    expect(within(screen.getByTestId("wallet-backup")).getByRole("status")).toHaveTextContent("Backup copied.");
  });
});

// covers: wallet.cashu.receive-lightning
describe("Receive's invoice reads paid only when it is paid", () => {
  /**
   * Receive's invoice reads "received" once this invoice is paid: its own mint quote in the history. Other money of the
   * same amount coming in meanwhile (a contact's ecash, our token taken back, a chat request paid) leaves it on screen.
   */
  const wallet: WalletPlatform = Object.assign(Object.create(servicesPlatform!.wallet), {
    receiveLightning: async () => ({ quote: "our-quote", invoice: REGTEST_INVOICE, expiresAt: null, source: "cashu-mint" }),
  });
  type Tx = WalletState["history"][number];
  const at = (network: "mainnet" | "testnet", url: string, balance: number, history: Tx[]) =>
    networkState(walletView({ mints: [mint(url, balance)], balance, history, mode: network }) as WalletState, network);
  const card = (state: WalletState) => <CashuWallet wallet={wallet} state={state} rail="cashu" onOpenCashu={() => {}} />;

  async function showInvoice(state: WalletState) {
    const view = renderApp(card(state));
    await view.user.click(screen.getByTestId("wallet-receive-amount"));
    await view.user.keyboard("1000{Enter}");
    await waitFor(() => expect(screen.getByTestId("wallet-invoice")).toBeInTheDocument());
    return view;
  }
  const shown = () => ({ said: screen.queryByTestId("wallet-paid")?.textContent ?? null, invoice: !!screen.queryByTestId("wallet-invoice") });

  it("stays on a contact's ecash of the same amount (Mainnet)", async () => {
    const MINT = DEFAULT_MINTS[0];
    const view = await showInvoice(at("mainnet", MINT, 5_000, []));
    const ecash: Tx = { id: "tx-ecash", timestamp: Date.now() + 1, mint: MINT, kind: "ecash-in", amount: 1_000, fee: 0, note: "for the pizza" };
    view.rerender(card(at("mainnet", MINT, 6_000, [ecash])));
    expect(shown()).toEqual({ said: null, invoice: true });
  });

  it("stays on our own ecash taken back (Mainnet: only the balance grows)", async () => {
    const MINT = DEFAULT_MINTS[0];
    const view = await showInvoice(at("mainnet", MINT, 4_000, []));
    view.rerender(card(at("mainnet", MINT, 5_000, [])));
    expect(shown()).toEqual({ said: null, invoice: true });
  });

  it("stays on a chat request of the same amount paid over Lightning (Testnet)", async () => {
    const MINT = TEST_MINTS[0];
    const view = await showInvoice(at("testnet", MINT, 5_000, []));
    const request: Tx = { id: "tx-req", timestamp: Date.now() + 1, mint: MINT, kind: "lightning-in", amount: 1_000, fee: 0, note: "Request paid over Lightning", quote: "a-request-quote" };
    view.rerender(card(at("testnet", MINT, 6_000, [request])));
    expect(shown()).toEqual({ said: null, invoice: true });
  });

  for (const network of ["mainnet", "testnet"] as const) {
    it(`says received once its own quote is minted (${network})`, async () => {
      const MINT = network === "mainnet" ? DEFAULT_MINTS[0] : TEST_MINTS[0];
      const view = await showInvoice(at(network, MINT, 5_000, []));
      const paid: Tx = { id: "tx-ours", timestamp: Date.now() + 1, mint: MINT, kind: "lightning-in", amount: 998, fee: 2, quote: "our-quote" };
      view.rerender(card(at(network, MINT, 5_998, [paid])));
      expect(shown()).toEqual({ said: expect.stringMatching(/1,000 (test )?sats received/), invoice: false });
    });
  }

  // The paid line takes the invoice's place: a screen reader hears it, and the focus that was in the invoice goes to Done,
  // then back to the amount, never to the page.
  it("says received to a screen reader, and keeps the focus from the invoice's Copy to Done to the amount", async () => {
    const MINT = TEST_MINTS[0];
    const view = await showInvoice(at("testnet", MINT, 5_000, []));
    // A live region is heard only when it was there before its text: it waits, empty, beside the invoice (Copy backup,
    // in the card's settings, has its own).
    const receiveStatus = () => screen.queryAllByRole("status").find((region) => !region.closest("[data-testid=wallet-backup]")) ?? null;
    const status = receiveStatus();
    await view.user.tab();
    expect(document.activeElement?.closest("[data-testid=wallet-invoice]")).not.toBeNull();
    const paid: Tx = { id: "tx-ours", timestamp: Date.now() + 1, mint: MINT, kind: "lightning-in", amount: 1_000, fee: 0, quote: "our-quote" };
    view.rerender(card(at("testnet", MINT, 6_000, [paid])));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Done" }));
    expect(status).not.toBeNull();
    expect(receiveStatus()).toBe(status);
    expect(status).toHaveTextContent(/1,000 test sats received/);
    await view.user.keyboard("{Enter}");
    expect(document.activeElement).toBe(screen.getByTestId("wallet-receive-amount"));
    expect(status).toHaveTextContent("");
  });

  it("leaves the focus where it went meanwhile", async () => {
    const MINT = TEST_MINTS[0];
    const view = await showInvoice(at("testnet", MINT, 5_000, []));
    const elsewhere = document.createElement("button");
    document.body.append(elsewhere);
    elsewhere.focus();
    const paid: Tx = { id: "tx-ours", timestamp: Date.now() + 1, mint: MINT, kind: "lightning-in", amount: 1_000, fee: 0, quote: "our-quote" };
    view.rerender(card(at("testnet", MINT, 6_000, [paid])));
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });
});

// covers: wallet.cashu.receive-lightning
describe("Receive's invoice past its expiry", () => {
  /**
   * Receive's invoice goes once it has expired: nobody can pay it then, so it is not offered to be copied or scanned, and
   * the screen no longer says it waits for a payment. Until then it stays.
   */
  const MINT = TEST_MINTS[0];
  const state = networkState(walletView({ mints: [mint(MINT, 5_000)], balance: 5_000, history: [], mode: "testnet" }) as WalletState, "testnet");
  const walletExpiringIn = (ms: number | null): WalletPlatform => Object.assign(Object.create(servicesPlatform!.wallet), {
    receiveLightning: async () => ({ quote: "our-quote", invoice: REGTEST_INVOICE, expiresAt: ms === null ? null : Date.now() + ms, source: "cashu-mint" }),
  });

  async function showInvoice(wallet: WalletPlatform) {
    const view = renderApp(<CashuWallet wallet={wallet} state={state} rail="cashu" onOpenCashu={() => {}} />);
    await view.user.click(screen.getByTestId("wallet-receive-amount"));
    await view.user.keyboard("1000{Enter}");
    await waitFor(() => expect(screen.getByTestId("wallet-invoice")).toBeInTheDocument());
    return view;
  }

  it("is replaced by a line saying it expired, with New amount", async () => {
    // Long enough for the invoice's line to take the focus first on a loaded runner (300 ms was not, now and then).
    const view = await showInvoice(walletExpiringIn(1_500));
    // The keys were on the invoice's line (where Create invoice put them): they go on New amount, not to the page. Both
    // moves are effects, run after the commit that shows the line: on a loaded runner React yields in between, so the
    // focus is waited for, not read at the first sight of the new line.
    await waitFor(() => expect(document.activeElement?.textContent).toMatch(/^Invoice for/));
    await waitFor(() => expect(screen.queryByTestId("wallet-invoice")).not.toBeInTheDocument(), { timeout: 5_000 });
    expect(screen.getByTestId("wallet-invoice-expired")).toHaveTextContent("This invoice expired: nobody can pay it now.");
    expect(screen.getByRole("alert")).toHaveTextContent("This invoice expired");
    expect(screen.queryByText(/Waiting for the payment/)).not.toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "New amount" })));
    await view.user.click(screen.getByRole("button", { name: "New amount" }));
    expect(screen.getByTestId("wallet-receive-amount")).toBeInTheDocument();
  });

  it("stays while it can still be paid", async () => {
    await showInvoice(walletExpiringIn(60 * 60_000));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(screen.getByTestId("wallet-invoice")).toBeInTheDocument();
    expect(screen.queryByTestId("wallet-invoice-expired")).not.toBeInTheDocument();
  });

  it("stays when the mint gave no expiry", async () => {
    await showInvoice(walletExpiringIn(null));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(screen.getByTestId("wallet-invoice")).toBeInTheDocument();
  });
});

// covers: wallet.cashu.receive-lightning
describe("Receive's invoice on screen", () => {
  /**
   * agents#2447: the engine asks less and less about an open invoice nobody looks at. While Receive shows one, it says so
   * (`watchInvoice`) and again every minute, so a payment still shows within seconds; once the invoice is paid or left,
   * it stops saying it.
   */
  afterEach(() => { vi.useRealTimers(); });
  const MINT = DEFAULT_MINTS[0];
  type Tx = WalletState["history"][number];
  const at = (history: Tx[]) => networkState(walletView({ mints: [mint(MINT, 5_000)], balance: 5_000, history, mode: "mainnet" }) as WalletState, "mainnet");

  it("is watched while it shows, again every minute, and no more once it is paid", async () => {
    // Only the intervals are fake: the clicks and the waits run on real time.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const watchInvoice = vi.fn(async () => {});
    const wallet: WalletPlatform = Object.assign(Object.create(servicesPlatform!.wallet), {
      receiveLightning: async () => ({ quote: "our-quote", invoice: REGTEST_INVOICE, expiresAt: null, source: "cashu-mint" }),
      watchInvoice,
    });
    const card = (state: WalletState) => <CashuWallet wallet={wallet} state={state} rail="cashu" onOpenCashu={() => {}} />;
    const view = renderApp(card(at([])));
    await view.user.click(screen.getByTestId("wallet-receive-amount"));
    await view.user.keyboard("1000{Enter}");
    await waitFor(() => expect(screen.getByTestId("wallet-invoice")).toBeInTheDocument());
    await waitFor(() => expect(watchInvoice).toHaveBeenCalledWith(REGTEST_INVOICE));
    // A new state from the engine (a render) does not say it again.
    view.rerender(card(at([])));
    expect(watchInvoice).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(60_000);
    expect(watchInvoice).toHaveBeenCalledTimes(2);

    const paid: Tx = { id: "tx-paid", timestamp: Date.now() + 1, mint: MINT, kind: "lightning-in", amount: 1_000, fee: 0, quote: "our-quote" };
    view.rerender(card(at([paid])));
    await waitFor(() => expect(screen.getByTestId("wallet-paid")).toBeInTheDocument());
    vi.advanceTimersByTime(5 * 60_000);
    expect(watchInvoice).toHaveBeenCalledTimes(2);
  });
});

// covers: wallet.cashu.pay-invoice
describe("Send's result is said to a screen reader", () => {
  /**
   * Send's result takes the review's place and its Done takes the keys: a screen reader hears "Done, button" and nothing
   * else unless the result is in a live region that was there, empty, before its text came.
   */
  const TEST_MINT = TEST_MINTS[0];
  const show = (paid: boolean, rail: "cashu" | "lightning") => {
    const base = networkState(walletView({ mode: "testnet", mints: [mint(TEST_MINT, 5_000)], balance: 5_000 }) as WalletState, "testnet");
    // The Lightning card on a node rather than the mints: its own pending line.
    const state = rail === "lightning" ? { ...base, lightning: { mode: "testnet", providerId: "lnd", status: "ready", balance: 5_000, offered: [], recent: [] } } as unknown as WalletState : base;
    const wallet: WalletPlatform = Object.assign(Object.create(servicesPlatform!.wallet), {
      getState: () => state, quoteInvoice: async () => ({ quote: "q-1", mint: TEST_MINT, amount: 5, feeReserve: 1 }), payQuote: async () => paid,
    });
    return renderApp(<CashuWallet wallet={wallet} state={state} rail={rail} onOpenCashu={() => {}} />);
  };

  for (const [paid, rail, line] of [
    [true, "cashu", "Paid."],
    [false, "cashu", "The payment is still pending at the mint."],
    [false, "lightning", "The payment is still pending. It is being checked; nothing is paid again."],
  ] as const) {
    it(`${rail} card, ${paid ? "paid" : "pending"}: "${line}" comes into a status line that was already there`, async () => {
      const { user } = show(paid, rail);
      await user.click(screen.getByRole("tab", { name: "Send" }));
      await user.click(screen.getByTestId("wallet-pay-input"));
      await user.paste(REGTEST_INVOICE);
      await user.click(screen.getByRole("button", { name: /^Pay/ }));
      const pay = await screen.findByTestId("wallet-pay-confirm");
      const before = new Set(screen.queryAllByRole("status"));
      await user.click(pay);
      await waitFor(() => expect(screen.getByTestId("wallet-send-done")).toHaveFocus());
      const said = [...before].filter((el) => el.isConnected && el.textContent === line);
      expect(said).toHaveLength(1);
    });
  }
});

// covers: wallet.cashu.receive-lightning, wallet.cashu.pay-invoice
describe("the focus after a wallet step", () => {
  /**
   * Receive's invoice and Send's quote take the place of the form that had the focus. The focus goes to their first line,
   * not to the page: the next Tab is the invoice's Copy or the quote's Pay, and a screen reader says what came.
   */
  const TEST_MINT = TEST_MINTS[0];
  const state = networkState(walletView({ mints: [mint(TEST_MINT, 1_000)], balance: 1_000 }) as WalletState, "testnet");
  const wallet: WalletPlatform = Object.assign(Object.create(servicesPlatform!.wallet), {
    receiveLightning: async () => ({ invoice: REGTEST_INVOICE, expiresAt: null, paymentHash: "hash" }),
    quoteInvoice: async () => ({ quote: "quote-1", mint: TEST_MINT, amount: 5, feeReserve: 1 }),
  });

  for (const rail of ["cashu", "lightning"] as const) {
    it(`goes to the invoice once Receive made it (${rail} card)`, async () => {
      const { user } = renderApp(<CashuWallet wallet={wallet} state={state} rail={rail} onOpenCashu={() => {}} />);
      await user.click(screen.getByTestId("wallet-receive-amount"));
      await user.keyboard("21{Enter}");
      await waitFor(() => expect(screen.getByTestId("wallet-invoice")).toBeInTheDocument());
      expect(screen.getByText(/Invoice for/)).toHaveFocus();
      await user.tab();
      // Its text (where it scrolls) or its Copy button: inside the invoice either way.
      expect(screen.getByTestId("wallet-invoice-external")).toContainElement(document.activeElement as HTMLElement);
    });
  }

  it("goes to the quote once Send asked the mint, then on to Pay", async () => {
    const { user } = renderApp(<CashuWallet wallet={wallet} state={state} rail="cashu" onOpenCashu={() => {}} />);
    await user.click(screen.getByRole("tab", { name: "Send" }));
    await user.click(screen.getByTestId("wallet-pay-input"));
    await user.paste(REGTEST_INVOICE);
    await user.tab();
    await user.keyboard("{Enter}");
    const pay = await screen.findByTestId("wallet-pay-confirm");
    expect(screen.getByText(/in fees/).closest("p")).toHaveFocus();
    await user.tab();
    expect(pay).toHaveFocus();
  });
});

// covers: wallet.history, payments.external
describe("scrolling wallet boxes take the keyboard", () => {
  /**
   * A box that scrolls is reached with Tab, so its end can be read with the keys. Chromium takes Tab into a scrolling box
   * by itself; WebKit (Safari, the iPhone app, the Desktop app's WebView) only when the box is focusable.
   */
  const invoice = `lntbs12340n1p${"q".repeat(300)}`;

  it("an invoice's text, before its Copy button", async () => {
    const { user } = renderApp(<PayExternally uri={`lightning:${invoice}`} value={invoice} testId="wallet-invoice" />);
    await user.tab();
    expect(screen.getByTestId("wallet-invoice")).toHaveFocus();
    await user.tab();
    expect(screen.getByTestId("wallet-invoice-copy")).toHaveFocus();
  });

  it("a Cashu wallet's history", async () => {
    const TEST_MINT = TEST_MINTS[0];
    const history = Array.from({ length: 12 }, (_, i) => ({ id: `tx${i}`, kind: "lightning-in" as const, amount: 100 + i, fee: 0, timestamp: 1_791_000_000_000 + i, mint: TEST_MINT }));
    const state = networkState(walletView({ mints: [mint(TEST_MINT, 1_266)], balance: 1_266, history }) as WalletState, "testnet");
    const { user } = renderApp(<CashuWallet wallet={servicesPlatform!.wallet} state={state} rail="cashu" onOpenCashu={() => {}} />);
    await user.click(screen.getByRole("tab", { name: "History" }));
    const list = screen.getByLabelText("History", { selector: "div" });
    expect(list).toHaveAttribute("tabindex", "0");
    expect(list.querySelectorAll("[data-testid=wallet-tx]")).toHaveLength(12);
  });
});

// covers: wallet.cashu.pay-invoice, wallet.lightning.card, app.i18n
describe("in Arabic, someone else's memo in the wallet keeps its own direction", () => {
  /**
   * A memo is text someone else wrote, in any script: in the wallet too it is laid out in its own direction, as the
   * chat's invoice card does (InvoiceBubble). Bare in an Arabic line, "1 cup coffee" read "1 · cup coffee": its "1" went
   * before the separator.
   */
  const MEMO = "1 cup coffee";

  it("a pasted invoice's description in Send", async () => {
    const state = networkState(walletView({ mints: [mint(TEST_MINT, 5_000)], balance: 5_000 }) as WalletState, "testnet");
    const { user } = renderApp(<CashuWallet wallet={servicesPlatform!.wallet} state={state} rail="cashu" onOpenCashu={() => {}} />, { language: "ar" });
    await user.click(screen.getByTestId("wallet-send"));
    await user.click(screen.getByTestId("wallet-pay-input"));
    await user.paste(fakeInvoice(1_000, new Uint8Array(32).fill(7), MEMO));
    const memo = await screen.findByText(MEMO);
    expect(memo.tagName).toBe("BDI");
    expect(screen.getByTestId("wallet-pay-preview")).toContainElement(memo);
  });

  it("a Lightning address's description, before and after the invoice", async () => {
    const info = { id: "addr-1", kind: "address", text: "alice@example.com", domain: "example.com", callbackDomain: "example.com", minSat: 1, maxSat: 100_000, description: MEMO, commentAllowed: 0 } as LightningAddressInfo;
    fakeEngine.setState({ wallet: walletView({ mints: [mint(TEST_MINT, 5_000)] }) });
    const { user, engine } = renderApp(<LightningAddressPay wallet={servicesPlatform!.wallet.forNetwork("testnet")} text="alice@example.com" />, { language: "ar" });
    engine.on("lnurlResolve", () => info).on("lnurlInvoice", () => ({ invoice: "lnbc-invoice", note: "Paid alice@example.com" }))
      .on("walletQuoteInvoice", () => ({ quote: "melt-1", amount: 2_100, feeReserve: 3, mint: TEST_MINT, expiry: Date.now() / 1000 + 600 }));
    await user.click(screen.getByTestId("lnurl-lookup"));
    expect((await screen.findByText(MEMO)).tagName).toBe("BDI");
    await user.type(screen.getByTestId("lnurl-amount"), "2100");
    await user.click(screen.getByTestId("lnurl-invoice"));
    await screen.findByTestId("lnurl-review");
    expect(screen.getByText(MEMO)).toHaveAttribute("dir", "auto");
  });
});

// covers: wallet.cashu.mint.add, wallet.lightning.sources
describe("an engine error, in the app's language", () => {
  /**
   * The engine writes its errors in English (the CLI prints them as they are). The ones it knows by a code reach the
   * person in the app's language; any other text, a mint's own words, stays as it is.
   */
  const wallet = servicesPlatform!.wallet;
  const onNetwork = (network: WalletNetwork, patch: Partial<WalletState>) => networkState(walletView(patch) as WalletState, network);

  it("a mint of the other network, refused (#815), says why in Portuguese", async () => {
    const { user, engine } = renderApp(<CashuWallet wallet={wallet.forNetwork("mainnet")} state={onNetwork("mainnet", { mints: [mint(REAL_MINT, 0)] })} rail="cashu" onOpenCashu={() => {}} />, { language: "pt" });
    engine.on("walletAddMint", () => { throw new Error(engineText("testMintOnMainnet")); });
    await user.type(screen.getByTestId("wallet-mint-url"), TEST_MINT);
    await user.click(screen.getByTestId("wallet-add-mint"));
    expect(await screen.findByTestId("wallet-error")).toHaveTextContent("Este é um mint de teste: seus sats não valem nada" + "Adicione-o a uma carteira Cashu Testnet.");
  });

  it("a mint that did not answer names it, in Portuguese; a mint's own words stay as they are", async () => {
    const { user, engine } = renderApp(<CashuWallet wallet={wallet.forNetwork("mainnet")} state={onNetwork("mainnet", { mints: [mint(REAL_MINT, 0)] })} rail="cashu" onOpenCashu={() => {}} />, { language: "pt" });
    engine.on("walletAddMint", () => { throw new Error(engineText("hostTimedOut", { host: "mint.example.org" })); });
    await user.type(screen.getByTestId("wallet-mint-url"), "https://mint.example.org");
    await user.click(screen.getByTestId("wallet-add-mint"));
    expect(await screen.findByTestId("wallet-error")).toHaveTextContent("mint.example.org não respondeu a tempo");
    engine.on("walletAddMint", () => { throw new Error("Keyset not active"); });
    await user.click(screen.getByTestId("wallet-add-mint"));
    expect(await screen.findByText("Keyset not active")).toBeInTheDocument();
  });

  it("a Lightning payment's error in the recent rows, in Portuguese", () => {
    const ln = lightningSource({ recent: [{ direction: "out", providerId: "cln-1", mode: "mainnet", paymentHash: "h", invoice: "lnbc1", amount: 70, expiresAt: 0, createdAt: 0, state: "failed", error: engineText("invoiceExpired") }] } as never);
    renderApp(<CashuWallet wallet={wallet} state={onNetwork("mainnet", { mints: [mint(REAL_MINT, 0)], lightning: ln })} rail="lightning" onOpenCashu={() => {}} />, { language: "pt" });
    expect(screen.getByTestId("lightning-op")).toHaveTextContent("Essa fatura expirou");
  });

  it("a payment's error in the chat, in Portuguese", () => {
    fakeEngine.setState({ links: [linkView()], wallet: { mints: [mint(REAL_MINT, 0)] }, payments: { "pay-1": paymentView({ kind: "payment", direction: "out", state: "failed", error: engineText("noSharedMint") }) } });
    renderApp(<PaymentBubble paymentId="pay-1" peerPubKey="peer" fallbackText="[a payment]" />, { language: "pt" });
    expect(screen.getByTestId("payment-state")).toHaveTextContent("Você não tem nenhum mint em comum com este contato");
  });

  // A mint that refuses a melt at once ("Lightning payment failed: no route"): its English stood alone (agents#2253).
  const refused = engineText("lightningRefused", { reason: "Lightning payment failed: no route" });

  it("a Lightning payment the mint refused, on the wallet page: no sats left, in Portuguese; the mint's words behind the ⓘ", async () => {
    const state = walletView({ mode: "testnet", mints: [mint(TEST_MINT, 9_500)], balance: 9_500 }) as WalletState;
    const { user, engine } = renderApp(<CashuWallet wallet={wallet} state={state} rail="cashu" onOpenCashu={() => {}} />, { language: "pt" });
    engine.on("walletQuoteInvoice", () => ({ quote: "melt-1", mint: TEST_MINT, amount: 300, feeReserve: 2 })).on("walletPayQuote", () => { throw new Error(refused); });
    await user.click(screen.getByTestId("wallet-send"));
    await user.type(screen.getByTestId("wallet-pay-input"), liveMainnetInvoice(300));
    await user.click(screen.getByRole("button", { name: /^Pagar 300 sats de teste$/ }));
    await user.click(await screen.findByTestId("wallet-pay-confirm"));
    const notice = await screen.findByTestId("wallet-error");
    expect(notice).toHaveTextContent("A mint recusou este pagamento Lightning" + "Nenhum sat saiu da sua carteira. Pode tentar de novo com segurança.");
    expect(notice).not.toHaveTextContent("no route");
    await user.click(screen.getByTestId("wallet-error-info"));
    expect(screen.getByTestId("wallet-error-details")).toHaveTextContent("The mint said: Lightning payment failed: no route");
  });

  it("a Lightning payment the mint refused, on a chat request: no sats left, in Portuguese", () => {
    fakeEngine.setState({ links: [linkView()], wallet: { mints: [mint(TEST_MINT, 9_500)] }, payments: { "req-1": paymentView({ kind: "request", direction: "in", state: "failed", error: refused }) } });
    renderApp(<PaymentBubble paymentId="req-1" peerPubKey="peer" fallbackText="[a request]" />, { language: "pt" });
    expect(screen.getByTestId("payment-state")).toHaveTextContent("A mint recusou este pagamento Lightning. Nenhum sat saiu da sua carteira.");
    expect(screen.getByTestId("payment-state")).not.toHaveTextContent("no route");
  });

  it("in English, the text is the engine's own, word for word", async () => {
    const { user, engine } = renderApp(<CashuWallet wallet={wallet.forNetwork("mainnet")} state={onNetwork("mainnet", { mints: [mint(REAL_MINT, 0)] })} rail="cashu" onOpenCashu={() => {}} />);
    engine.on("walletAddMint", () => { throw new Error(engineText("realMintOnTestnet")); });
    await user.type(screen.getByTestId("wallet-mint-url"), "https://mint.example.org");
    await user.click(screen.getByTestId("wallet-add-mint"));
    expect(await screen.findByTestId("wallet-error")).toHaveTextContent(/^This mint holds real sats: add it to a Mainnet Cashu wallet$/);
  });
});
