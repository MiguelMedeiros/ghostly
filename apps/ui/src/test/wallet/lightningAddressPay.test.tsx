import { act, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { decodeBolt11 } from "@ghostly/core";
import { MessageBubble } from "../../components/MessageBubble";
import { CashuWallet } from "../../components/wallet/CashuWallet";
import { LightningAddressPay } from "../../components/wallet/LightningAddressPay";
import { networkState } from "../../components/walletCardData";
import { servicesPlatform, type LightningAddressInfo, type WalletPlatform, type WalletState } from "../../lib/platform";
import { fakeEngine, linkView, walletView } from "../fakeEngine";
import { mint, REGTEST_INVOICE, TEST_MINT } from "../payments/fixtures";
import { renderApp } from "../render";

// covers: payments.lnurl.card, wallet.cashu.pay-invoice
describe("paying a Lightning address keeps the keyboard's place", () => {
  /**
   * Paying a Lightning address from the keyboard: the button pressed keeps the focus while it works (busy, not disabled:
   * a disabled one drops it to the page in Chromium) and after a refusal, and each step that comes takes it.
   */
  const info = { id: "addr-1", kind: "address", text: "alice@example.com", domain: "example.com", callbackDomain: "example.com", minSat: 1, maxSat: 100_000, description: "Alice", commentAllowed: 0 } as LightningAddressInfo;
  const later = <T,>() => { let answer!: (value: T) => void; const promise = new Promise<T>((resolve) => { answer = resolve; }); return { promise, answer }; };
  const show = () => {
    fakeEngine.setState({ wallet: walletView({ mode: "testnet", mints: [mint(TEST_MINT, 5_000)], balance: 5_000 }) });
    return renderApp(<LightningAddressPay wallet={servicesPlatform!.wallet.forNetwork("testnet")} text="alice@example.com" />);
  };
  const busy = (button: HTMLElement) => {
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toBeEnabled();
    expect(button).toHaveFocus();
  };

  it("Look up, Get invoice and Pay: busy where they were pressed, then the next step's line", async () => {
    const { user, engine } = show();
    const resolve = later<LightningAddressInfo>(), invoice = later<{ invoice: string; note: string }>(), paid = later<{ paid: boolean }>();
    engine.on("lnurlResolve", () => resolve.promise).on("lnurlInvoice", () => invoice.promise)
      .on("walletQuoteInvoice", () => ({ quote: "melt-1", mint: TEST_MINT, amount: 2_100, feeReserve: 3 })).on("walletPayQuote", () => paid.promise);

    const lookUp = screen.getByTestId("lnurl-lookup");
    lookUp.focus();
    await user.keyboard("{Enter}");
    busy(lookUp);
    await user.keyboard("{Enter}");
    resolve.answer(info);
    await waitFor(() => expect(screen.getByTestId("lnurl-amount")).toHaveFocus());

    await user.keyboard("2100");
    const getInvoice = screen.getByTestId("lnurl-invoice");
    getInvoice.focus();
    await user.keyboard("{Enter}");
    busy(getInvoice);
    invoice.answer({ invoice: "lnbc-invoice", note: "Paid alice@example.com" });
    const pay = await screen.findByTestId("lnurl-pay");
    expect(document.activeElement).toHaveTextContent(/^Pay 2,100 test sats to alice@example\.com/);

    pay.focus();
    await user.keyboard("{Enter}");
    busy(pay);
    await user.keyboard("{Enter}");
    paid.answer({ paid: true });
    await waitFor(() => expect(screen.getByTestId("lnurl-paid")).toHaveFocus());
    expect(engine.callsTo("lnurlResolve")).toHaveLength(1);
    expect(engine.callsTo("walletPayQuote")).toHaveLength(1);
  });

  it("a refused look-up leaves the focus on Look up, by its error", async () => {
    const { user, engine } = show();
    engine.on("lnurlResolve", () => { throw new Error("example.com did not answer"); });
    const lookUp = screen.getByTestId("lnurl-lookup");
    lookUp.focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByTestId("lnurl-error")).toBeInTheDocument();
    expect(lookUp).toHaveFocus();
    expect(lookUp).not.toHaveAttribute("aria-busy");
  });

  /** Look up, 2,100 sats, Get invoice and Pay (test sats: no second step), then Done pressed from the keyboard. */
  const payThenDone = async (user: ReturnType<typeof renderApp>["user"], engine: ReturnType<typeof renderApp>["engine"]) => {
    engine.on("lnurlResolve", () => info).on("lnurlInvoice", () => ({ invoice: "lnbc-invoice", note: "Paid alice@example.com" }))
      .on("walletQuoteInvoice", () => ({ quote: "melt-1", mint: TEST_MINT, amount: 2_100, feeReserve: 3 })).on("walletPayQuote", () => ({ paid: true }));
    await user.click(screen.getByTestId("lnurl-lookup"));
    await user.type(await screen.findByTestId("lnurl-amount"), "2100");
    await user.click(screen.getByTestId("lnurl-invoice"));
    await user.click(await screen.findByTestId("lnurl-pay"));
    expect(await screen.findByTestId("lnurl-paid")).toBeInTheDocument();
    screen.getByRole("button", { name: "Done" }).focus();
    await user.keyboard("{Enter}");
    expect(screen.queryByTestId("lnurl-done")).not.toBeInTheDocument();
  };

  it("Done in a chat's address card puts the keys back on its Pay, not on the page", async () => {
    fakeEngine.setState({ links: [linkView()], wallet: walletView({ mode: "testnet", mints: [mint(TEST_MINT, 5_000)], balance: 5_000 }) });
    const { user, engine } = renderApp(<MessageBubble message={{ id: "m1", text: "alice@example.com", sender: "peer", timestamp: Date.now(), status: "delivered" } as never} peerPubKey="peer" />);
    await user.click(screen.getByTestId("lnurl-pay-open"));
    await payThenDone(user, engine);
    await waitFor(() => expect(screen.getByTestId("lnurl-pay-open")).toHaveFocus());
  });

  it("Done on the Cashu card's Send puts the keys in the emptied paste field, not on the page", async () => {
    const state = walletView({ mode: "testnet", mints: [mint(TEST_MINT, 5_000)], balance: 5_000 }) as WalletState;
    fakeEngine.setState({ wallet: state });
    const { user, engine } = renderApp(<CashuWallet wallet={servicesPlatform!.wallet} state={state} rail="cashu" onOpenCashu={() => {}} />);
    await user.click(screen.getByTestId("wallet-send"));
    await user.type(screen.getByTestId("wallet-pay-input"), "alice@example.com");
    await payThenDone(user, engine);
    expect(screen.getByTestId("wallet-pay-input")).toHaveValue("");
    expect(screen.getByTestId("wallet-pay-input")).toHaveFocus();
  });
});

// covers: payments.lnurl.card
describe("paying a Lightning address, going back a step", () => {
  /** A refusal belongs to the step that got it: going back a step leaves it behind, so it never reads as being about that one. */
  const info = { id: "addr-1", kind: "address", text: "alice@example.com", domain: "example.com", callbackDomain: "example.com", minSat: 1, maxSat: 100_000, description: "Alice", commentAllowed: 0 } as LightningAddressInfo;
  const show = () => {
    fakeEngine.setState({ wallet: walletView({ mode: "testnet", mints: [mint(TEST_MINT, 5_000)], balance: 5_000 }) });
    return renderApp(<LightningAddressPay wallet={servicesPlatform!.wallet.forNetwork("testnet")} text="alice@example.com" />);
  };

  it("Cancel after a refused payment: the amount step shows no refusal", async () => {
    const { user, engine } = show();
    engine.on("lnurlResolve", () => info).on("lnurlInvoice", () => ({ invoice: "lnbc-invoice", note: "Paid alice@example.com" }))
      .on("walletQuoteInvoice", () => ({ quote: "melt-1", mint: TEST_MINT, amount: 2_100, feeReserve: 3 }))
      .on("walletPayQuote", () => { throw new Error("Invoice already paid"); });
    await user.click(screen.getByTestId("lnurl-lookup"));
    await user.type(await screen.findByTestId("lnurl-amount"), "2100");
    await user.click(screen.getByTestId("lnurl-invoice"));
    await user.click(await screen.findByTestId("lnurl-pay"));
    expect(await screen.findByTestId("lnurl-error")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByTestId("lnurl-amount-form")).toBeInTheDocument();
    expect(screen.queryByTestId("lnurl-error")).toBeNull();
  });

  it("Back after a refused invoice: the look-up step shows no refusal", async () => {
    const { user, engine } = show();
    engine.on("lnurlResolve", () => info).on("lnurlInvoice", () => { throw new Error("example.com did not answer"); });
    await user.click(screen.getByTestId("lnurl-lookup"));
    await user.type(await screen.findByTestId("lnurl-amount"), "2100");
    await user.click(screen.getByTestId("lnurl-invoice"));
    expect(await screen.findByTestId("lnurl-error")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByTestId("lnurl-resolve")).toBeInTheDocument();
    expect(screen.queryByTestId("lnurl-error")).toBeNull();
  });
});

// covers: wallet.lightning.card
describe("before a Lightning lookup, the host named is the one asked", () => {
  /**
   * Before Look up, the line names the server that will learn of the payment: the host the lookup really asks, read as
   * the engine reads it. Read from the raw text, an `@` in an LNURL's path named another host, and a bech32 LNURL named
   * none at all.
   */
  /** `https://192.168.1.1/x` as a bech32 LNURL. */
  const LAN_LNURL = "lnurl1dp68gurn8ghj7vfexghrzd3c9ccjuvf00q0uhs8q";

  const lookupLine = (text: string) => {
    fakeEngine.setState({ wallet: walletView({ mints: [mint(TEST_MINT, 5_000)] }) });
    renderApp(<LightningAddressPay wallet={servicesPlatform!.wallet.forNetwork("testnet")} text={text} />);
    return screen.getByTestId("lnurl-resolve");
  };

  it("an lnurlp:// with an @ in its path names its own host", () => {
    const line = lookupLine("lnurlp://evil.example/@good.example");
    expect(line).toHaveTextContent("evil.example");
    expect(line).not.toHaveTextContent("good.example");
  });

  it("a bech32 LNURL names the host it decodes to", () => {
    expect(lookupLine(LAN_LNURL)).toHaveTextContent("192.168.1.1");
  });

  it("an address names its domain", () => {
    expect(lookupLine("alice@example.com")).toHaveTextContent("example.com");
  });
});

// covers: payments.lnurl.card
describe("the link a Lightning service leaves after a payment", () => {
  /**
   * The link a service leaves after a payment (a LUD-09 `url` success action) reads as the address it opens, as a link
   * in a chat does: a user part does not read as the host, a look-alike host shows in punycode, and the service's own
   * words before it cannot turn it around.
   */
  const info = { id: "addr-1", kind: "address", text: "alice@example.com", domain: "example.com", callbackDomain: "example.com", minSat: 1, maxSat: 100_000, description: "Alice", commentAllowed: 0 } as LightningAddressInfo;
  const paidWith = async (successAction: { tag: "url"; description?: string; url: string }) => {
    fakeEngine.setState({ wallet: walletView({ mode: "testnet", mints: [mint(TEST_MINT, 5_000)], balance: 5_000 }) });
    const { user, engine } = renderApp(<LightningAddressPay wallet={servicesPlatform!.wallet.forNetwork("testnet")} text="alice@example.com" />);
    engine.on("lnurlResolve", () => info).on("lnurlInvoice", () => ({ invoice: "lnbc-invoice", note: "Paid alice@example.com", successAction }))
      .on("walletQuoteInvoice", () => ({ quote: "melt-1", mint: TEST_MINT, amount: 21, feeReserve: 1 }))
      .on("walletPayQuote", () => ({ paid: true }));
    await user.click(screen.getByTestId("lnurl-lookup"));
    await user.type(await screen.findByTestId("lnurl-amount"), "21");
    await user.click(screen.getByTestId("lnurl-invoice"));
    await user.click(await screen.findByTestId("lnurl-pay"));
    return screen.findByTestId("lnurl-done");
  };

  it("a user part is left out: the host it reads as is the one it opens", async () => {
    const done = await paidWith({ tag: "url", description: "Your receipt", url: "https://www.paypal.com@evil.example/receipt" });
    const link = done.querySelector("a")!;
    expect(new URL(link.getAttribute("href")!).host).toBe("evil.example");
    expect(link.textContent).toBe("https://evil.example/receipt");
    expect(done.textContent).not.toContain("paypal");
  });

  it("a look-alike host shows in punycode", async () => {
    const done = await paidWith({ tag: "url", description: "Your receipt", url: "https://рaypal.com/receipt" });
    expect(done.querySelector("a")!.textContent).toBe("https://xn--aypal-uye.com/receipt");
  });

  it("the service's words cannot turn the link around", async () => {
    const done = await paidWith({ tag: "url", description: "Receipt ‮", url: "https://evil.example/?x=moc.lapyap.www//:sptth" });
    const words = done.querySelector("bdi")!;
    expect(words.textContent).toBe("Receipt ‮");
    expect(words.contains(done.querySelector("a"))).toBe(false);
  });
});

// covers: wallet.lnurl.address, wallet.cashu.pay-invoice
describe("a Lightning address or LNURL the mint leaves pending reads as waiting, as an invoice does", () => {
  /**
   * Paid through the mints and left pending there, an address or LNURL payment says what an invoice's Pay says: still
   * pending at the mint, and the next step (it settles by itself, the amount set aside meanwhile), in the waiting tone.
   * It was the generic "being checked" line in the paid line's accent and weight, as if it had gone.
   */
  const info = (text: string) => ({ id: "addr-1", kind: "address", text, domain: "example.com", callbackDomain: "example.com", minSat: 1, maxSat: 100_000, description: "Alice", commentAllowed: 0 }) as LightningAddressInfo;
  /** `https://example.com/.well-known/lnurlp/alice` as a bech32 LNURL. */
  const LNURL = "lnurl1dp68gurn8ghj7etcv9khqmr99e3k7mf09emk2mrv944kummhdchkcmn4wfk8qtmpd35kxeg9saevq";
  const WORDS = {
    en: { title: "The payment is still pending at the mint.", next: "It settles by itself; nothing is paid again. Until the mint answers, the amount shows as set aside under the balance." },
    ar: { title: "لا تزال الدفعة معلّقة لدى دار السك.", next: "تُحسم الدفعة من تلقاء نفسها، ولن يُدفع شيء مرة أخرى. وإلى أن تجيب دار السك، يظهر المبلغ محجوزًا تحت الرصيد." },
  };
  const methods = (text: string, paid: boolean, source?: string): Partial<WalletPlatform> => ({
    resolveLightningAddress: async () => info(text),
    lightningAddressInvoice: async () => ({ invoice: "lnbcrt-x", note: `Paid ${text}` }),
    quoteInvoice: async () => ({ quote: "q-2", mint: TEST_MINT, amount: 5, feeReserve: 1, ...(source ? { source } : {}) }),
    payQuote: async () => paid,
  });
  /** The Cashu card's Send: the address or LNURL pasted, looked up, 5 sats, its invoice, and Pay (test sats: no second step). */
  const payOnCashuCard = async (text: string, paid: boolean, language: "en" | "ar" = "en") => {
    fakeEngine.setState({ wallet: walletView({ mode: "testnet", mints: [mint(TEST_MINT, 5_000)], balance: 5_000 }) });
    const state = networkState(walletView({ mode: "testnet", mints: [mint(TEST_MINT, 5_000)], balance: 5_000 }) as WalletState, "testnet");
    const wallet: WalletPlatform = Object.assign(Object.create(servicesPlatform!.wallet.forNetwork("testnet")), methods(text, paid));
    const { user } = renderApp(<CashuWallet wallet={wallet} state={state} rail="cashu" onOpenCashu={() => {}} />, { language });
    await user.click(screen.getByTestId("wallet-send"));
    await user.click(screen.getByTestId("wallet-pay-input"));
    await user.paste(text);
    await user.click(await screen.findByTestId("lnurl-lookup"));
    await user.type(await screen.findByTestId("lnurl-amount"), "5");
    await user.click(screen.getByTestId("lnurl-invoice"));
    (await screen.findByTestId("lnurl-pay")).focus();
    await user.keyboard("{Enter}");
  };
  const waiting = (line: HTMLElement) => {
    expect(line).toHaveAttribute("data-tone", "wait");
    expect(line.className).not.toMatch(/text-accent|font-semibold/);
  };

  for (const language of ["en", "ar"] as const) {
    for (const [kind, text] of [["Lightning address", "alice@example.com"], ["LNURL", LNURL]] as const) {
      it(`${language}: the Cashu card's ${kind} payment left pending says the mint holds it, what comes next, and waits`, async () => {
        await payOnCashuCard(text, false, language);
        const line = await screen.findByTestId("lnurl-pending");
        waiting(line);
        expect(screen.getByTestId("lnurl-pending-title")).toHaveTextContent(WORDS[language].title);
        expect(screen.getByTestId("lnurl-pending-next")).toHaveTextContent(WORDS[language].next);
        expect(screen.queryByTestId("lnurl-paid")).toBeNull();
        // The line takes the keys, as the paid one does: Done is the next Tab.
        await waitFor(() => expect(line.parentElement).toHaveFocus());
      });
    }
  }

  it("paid, the line keeps the paid accent and weight", async () => {
    await payOnCashuCard("alice@example.com", true);
    const line = await screen.findByTestId("lnurl-paid");
    expect(line.className).toMatch(/text-accent/);
    expect(line.className).toMatch(/font-semibold/);
    expect(line).toHaveTextContent("Paid 5 test sats to alice@example.com");
    expect(screen.queryByTestId("lnurl-pending")).toBeNull();
  });

  for (const [source, title, next] of [
    ["lnd", "The payment is still pending. It is being checked; nothing is paid again.", null],
    ["cashu-mint", WORDS.en.title, WORDS.en.next],
  ] as const) {
    it(`through a Lightning card on ${source === "lnd" ? "a node" : "the mints"}, left pending: ${source === "lnd" ? "the source's line" : "the mint's words"}, waiting too`, async () => {
      fakeEngine.setState({ wallet: walletView({ mode: "testnet", mints: [mint(TEST_MINT, 5_000)], balance: 5_000 }) });
      const wallet: WalletPlatform = Object.assign(Object.create(servicesPlatform!.wallet.forNetwork("testnet")), methods("alice@example.com", false, source));
      const { user } = renderApp(<LightningAddressPay wallet={wallet} text="alice@example.com" />);
      await user.click(screen.getByTestId("lnurl-lookup"));
      await user.type(await screen.findByTestId("lnurl-amount"), "5");
      await user.click(screen.getByTestId("lnurl-invoice"));
      await user.click(await screen.findByTestId("lnurl-pay"));
      waiting(await screen.findByTestId("lnurl-pending"));
      expect(screen.getByTestId("lnurl-pending-title")).toHaveTextContent(title);
      if (next) expect(screen.getByTestId("lnurl-pending-next")).toHaveTextContent(next);
      else expect(screen.queryByTestId("lnurl-pending-next")).toBeNull();
    });
  }

  describe("left pending, it follows the payment until Done, as an invoice's Pay does", () => {
    /**
     * The pending line is what the mint said when Pay was answered, not where the money is. Once the mint settles it (its
     * melt quote on a History row, or the set-aside back with no row of it) or the paying Lightning card's journal does
     * (by the invoice's hash), the same place says how it ended. It said "still pending at the mint" until Done, with the
     * sats paid or back in the balance.
     */
    const stateOf = (patch: Partial<WalletState>) => walletView({ mode: "testnet", mints: [mint(TEST_MINT, 5_000)], balance: 5_000, ...patch });
    const out = (kind: "lightning-out" | "fee", fee: number, quote = "q-2") => ({ id: `${kind}-${quote}`, timestamp: Date.now(), mint: TEST_MINT, kind, amount: kind === "fee" ? 0 : 5, fee, quote });
    const pendingOnCashuCard = async () => {
      fakeEngine.setState({ wallet: stateOf({ setAside: 6 } as Partial<WalletState>) });
      const wallet: WalletPlatform = Object.assign(Object.create(servicesPlatform!.wallet.forNetwork("testnet")), methods("alice@example.com", false));
      const state = networkState(stateOf({}) as WalletState, "testnet");
      const shown = renderApp(<CashuWallet wallet={wallet} state={state} rail="cashu" onOpenCashu={() => {}} />);
      await shown.user.click(screen.getByTestId("wallet-send"));
      await shown.user.click(screen.getByTestId("wallet-pay-input"));
      await shown.user.paste("alice@example.com");
      await shown.user.click(await screen.findByTestId("lnurl-lookup"));
      await shown.user.type(await screen.findByTestId("lnurl-amount"), "5");
      await shown.user.click(screen.getByTestId("lnurl-invoice"));
      await shown.user.click(await screen.findByTestId("lnurl-pay"));
      expect(await screen.findByTestId("lnurl-pending")).toBeInTheDocument();
      return shown.engine;
    };

    it("paid at the mint: the line turns into the paid one", async () => {
      const engine = await pendingOnCashuCard();
      // Another payment is not this one: only its own quote settles it.
      act(() => engine.setState({ wallet: stateOf({ setAside: 6, history: [out("lightning-out", 0, "q-other")] } as Partial<WalletState>) }));
      expect(screen.getByTestId("lnurl-pending")).toBeInTheDocument();
      engine.setState({ wallet: stateOf({ balance: 4_995, history: [out("lightning-out", 0)] }) });
      expect(await screen.findByTestId("lnurl-paid")).toHaveTextContent("Paid 5 test sats to alice@example.com");
      expect(screen.queryByTestId("lnurl-pending")).toBeNull();
      // The view keeps the newest 100 History rows: once newer ones push this payment's row out, it still reads as paid.
      const newer = Array.from({ length: 100 }, (_, i) => ({ id: `in-${i}`, timestamp: Date.now() + i, mint: TEST_MINT, kind: "lightning-in" as const, amount: 1, fee: 0, quote: `q-in-${i}` }));
      act(() => engine.setState({ wallet: stateOf({ balance: 5_095, history: newer }) }));
      expect(screen.getByTestId("lnurl-paid")).toBeInTheDocument();
      expect(screen.queryByTestId("lnurl-failed")).toBeNull();
    });

    it("failed at the mint: it says the payee was not paid and the sats are back", async () => {
      const engine = await pendingOnCashuCard();
      await waitFor(() => expect(screen.getByTestId("lnurl-pending").parentElement).toHaveFocus());
      engine.setState({ wallet: stateOf({}) });
      const line = await screen.findByTestId("lnurl-failed");
      expect(line).toHaveAttribute("data-tone", "warning");
      // The keys were on the waiting line: its end takes them, so it is read.
      await waitFor(() => expect(line.parentElement).toHaveFocus());
      expect(screen.getByTestId("lnurl-failed-title")).toHaveTextContent("The payment failed: the payee was not paid.");
      expect(screen.getByTestId("lnurl-failed-next")).toHaveTextContent("What was set aside for it is back in your balance.");
      expect(screen.queryByTestId("lnurl-pending")).toBeNull();
    });

    it("failed with a fee the mint kept, while another payment stays set aside: it says the fee", async () => {
      const engine = await pendingOnCashuCard();
      engine.setState({ wallet: stateOf({ balance: 4_999, setAside: 20, history: [out("fee", 1)] } as Partial<WalletState>) });
      expect(await screen.findByTestId("lnurl-failed-next")).toHaveTextContent("What was set aside for it is back in your balance, less 1 test sat the mint kept as a fee (in the history).");
    });

    it("through a Lightning card: its journal's failed payment of the invoice ends it", async () => {
      const hash = decodeBolt11(REGTEST_INVOICE)!.paymentHash!;
      const withOp = (state: "pending" | "failed") => { const s = stateOf({}); return { ...s, lightning: { mode: "testnet", providerId: "lnd", status: "ready", offered: [], recent: [{ direction: "out", paymentHash: hash, invoice: REGTEST_INVOICE, amount: 5, createdAt: Date.now(), state }] } } as never; };
      fakeEngine.setState({ wallet: stateOf({}) });
      const wallet: WalletPlatform = Object.assign(Object.create(servicesPlatform!.wallet.forNetwork("testnet")), { ...methods("alice@example.com", false, "lnd"), lightningAddressInvoice: async () => ({ invoice: REGTEST_INVOICE, note: "Paid alice@example.com" }) });
      const { user, engine } = renderApp(<LightningAddressPay wallet={wallet} text="alice@example.com" />);
      await user.click(screen.getByTestId("lnurl-lookup"));
      await user.type(await screen.findByTestId("lnurl-amount"), "5");
      await user.click(screen.getByTestId("lnurl-invoice"));
      await user.click(await screen.findByTestId("lnurl-pay"));
      expect(await screen.findByTestId("lnurl-pending")).toBeInTheDocument();
      engine.setState({ wallet: withOp("pending") });
      expect(screen.getByTestId("lnurl-pending")).toBeInTheDocument();
      engine.setState({ wallet: withOp("failed") });
      expect(await screen.findByTestId("lnurl-failed-title")).toHaveTextContent("The payment failed: the payee was not paid.");
      // A node's failure says nothing of a set-aside: that is the mints' word.
      expect(screen.queryByTestId("lnurl-failed-next")).toBeNull();
    });

    it("through a Lightning card: paid in its journal, it stays paid once 20 newer entries push it out", async () => {
      const hash = decodeBolt11(REGTEST_INVOICE)!.paymentHash!;
      const withRecent = (recent: unknown[]) => { const s = stateOf({}); return { ...s, lightning: { mode: "testnet", providerId: "lnd", status: "ready", offered: [], recent } } as never; };
      fakeEngine.setState({ wallet: stateOf({}) });
      const wallet: WalletPlatform = Object.assign(Object.create(servicesPlatform!.wallet.forNetwork("testnet")), { ...methods("alice@example.com", false, "lnd"), lightningAddressInvoice: async () => ({ invoice: REGTEST_INVOICE, note: "Paid alice@example.com" }) });
      const { user, engine } = renderApp(<LightningAddressPay wallet={wallet} text="alice@example.com" />);
      await user.click(screen.getByTestId("lnurl-lookup"));
      await user.type(await screen.findByTestId("lnurl-amount"), "5");
      await user.click(screen.getByTestId("lnurl-invoice"));
      await user.click(await screen.findByTestId("lnurl-pay"));
      expect(await screen.findByTestId("lnurl-pending")).toBeInTheDocument();
      engine.setState({ wallet: withRecent([{ direction: "out", paymentHash: hash, invoice: REGTEST_INVOICE, amount: 5, createdAt: Date.now(), state: "paid" }]) });
      expect(await screen.findByTestId("lnurl-paid")).toBeInTheDocument();
      // The journal the view keeps is its newest 20 entries.
      act(() => engine.setState({ wallet: withRecent(Array.from({ length: 20 }, (_, i) => ({ direction: "in", paymentHash: `h-${i}`, amount: 1, createdAt: Date.now() + i, state: "paid" }))) }));
      expect(screen.getByTestId("lnurl-paid")).toBeInTheDocument();
      expect(screen.queryByTestId("lnurl-pending")).toBeNull();
    });
  });

  describe("the service's words for a paid invoice show only once it is paid", () => {
    /**
     * What a service leaves after a payment (a LUD-09 success action: its thanks, or a link to a receipt or a download) is
     * for a payment that went. It showed under the waiting line, and under "the payee was not paid" once it failed.
     */
    const stateOf = (patch: Partial<WalletState>) => walletView({ mode: "testnet", mints: [mint(TEST_MINT, 5_000)], balance: 5_000, ...patch });
    const pendingWith = async (successAction: { tag: "message"; message: string } | { tag: "url"; description: string; url: string }) => {
      fakeEngine.setState({ wallet: stateOf({ setAside: 6 } as Partial<WalletState>) });
      const wallet: WalletPlatform = Object.assign(Object.create(servicesPlatform!.wallet.forNetwork("testnet")), {
        ...methods("alice@example.com", false),
        lightningAddressInvoice: async () => ({ invoice: "lnbcrt-x", note: "Paid alice@example.com", successAction }),
      });
      const { user, engine } = renderApp(<LightningAddressPay wallet={wallet} text="alice@example.com" via="cashu" />);
      await user.click(screen.getByTestId("lnurl-lookup"));
      await user.type(await screen.findByTestId("lnurl-amount"), "5");
      await user.click(screen.getByTestId("lnurl-invoice"));
      await user.click(await screen.findByTestId("lnurl-pay"));
      return { engine, done: await screen.findByTestId("lnurl-done") };
    };

    for (const action of [{ tag: "message", message: "Thanks for the coffee" }, { tag: "url", description: "Your receipt", url: "https://example.com/receipt" }] as const) {
      it(`a ${action.tag}: not while pending, not once failed`, async () => {
        const { engine, done } = await pendingWith(action);
        expect(screen.getByTestId("lnurl-pending")).toBeInTheDocument();
        expect(done.textContent).not.toMatch(/Thanks for the coffee|Your receipt/);
        expect(done.querySelector("a")).toBeNull();
        engine.setState({ wallet: stateOf({}) });
        expect(await screen.findByTestId("lnurl-failed")).toBeInTheDocument();
        expect(screen.getByTestId("lnurl-done").textContent).not.toMatch(/Thanks for the coffee|Your receipt/);
        expect(screen.getByTestId("lnurl-done").querySelector("a")).toBeNull();
      });

      it(`a ${action.tag}: shown once the pending payment is paid`, async () => {
        const { engine } = await pendingWith(action);
        engine.setState({ wallet: stateOf({ balance: 4_995, history: [{ id: "out-q-2", timestamp: Date.now(), mint: TEST_MINT, kind: "lightning-out", amount: 5, fee: 0, quote: "q-2" }] } as Partial<WalletState>) });
        expect(await screen.findByTestId("lnurl-paid")).toBeInTheDocument();
        const done = screen.getByTestId("lnurl-done");
        if (action.tag === "message") expect(screen.getByTestId("lnurl-success")).toHaveTextContent("example.com says: Thanks for the coffee");
        else expect(done.querySelector("a")).toHaveTextContent("https://example.com/receipt");
      });
    }
  });
});
