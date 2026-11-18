import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TEST_MINTS } from "@ghostly/browser/shared/mints";
import { CashuWallet } from "../../components/wallet/CashuWallet";
import { networkState } from "../../components/walletCardData";
import { servicesPlatform, type WalletPlatform, type WalletState } from "../../lib/platform";
import { walletView } from "../fakeEngine";
import { REGTEST_INVOICE, mint } from "../payments/fixtures";
import { renderApp } from "../render";

// covers: wallet.cashu.receive-token, wallet.cashu.pay-invoice
describe("the Cashu card says what Redeem and a pending Pay came to", () => {
  /**
   * Send's answers by keyboard or screen reader: a redeemed token is said once, in the status line Send already has (a
   * line there, empty, before its text), and the keys go to the emptied field rather than staying on the submit button
   * that turned into an unavailable Pay. A payment the mint left pending reads as waiting, not as paid, and says what
   * happens next. Texts are compared by `textContent` (happy-dom spaces `<bdi>` in accessible names).
   */
  const TEST_MINT = TEST_MINTS[0];
  const TOKEN = "cashuBo2FteBtodHRwczovL3Rlc3RudXQuY2FzaHUuc3BhY2VhdWNzYXRhdIGiYWlIAJofKTJT5B5hcIGkYWEBYXN4QDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMGFjWCECAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const WORDS = {
    en: {
      redeemed: "Redeemed 8 test sats.",
      pending: "The payment is still pending at the mint.",
      next: "It settles by itself; nothing is paid again. Until the mint answers, the amount shows as set aside under the balance.",
      setAside: "6 test sats set aside",
    },
    ar: {
      redeemed: "استُرد 8 sats تجريبية.",
      pending: "لا تزال الدفعة معلّقة لدى دار السك.",
      next: "تُحسم الدفعة من تلقاء نفسها، ولن يُدفع شيء مرة أخرى. وإلى أن تجيب دار السك، يظهر المبلغ محجوزًا تحت الرصيد.",
      setAside: "6 sats تجريبية محجوزة",
    },
  } as const;
  const show = (methods: Partial<WalletPlatform>, language: keyof typeof WORDS, patch: Partial<WalletState> = {}) => {
    const state = networkState(walletView({ mode: "testnet", mints: [mint(TEST_MINT, 5_000)], balance: 5_000, ...patch }) as WalletState, "testnet");
    const wallet: WalletPlatform = Object.assign(Object.create(servicesPlatform!.wallet), methods);
    return renderApp(<CashuWallet wallet={wallet} state={state} rail="cashu" onOpenCashu={() => {}} />, { language });
  };
  const said = () => screen.getAllByRole("status").map((line) => line.textContent ?? "");
  const submit = () => screen.getAllByRole("button").find((button) => button.getAttribute("type") === "submit")!;
  const live = (element: Element) => element.closest("[role=status],[role=alert],[aria-live]");

  for (const language of ["en", "ar"] as const) {
    const words = WORDS[language];

    it(`${language}: a redeemed token is said once, in Send's status line, and the keys go to the emptied field`, async () => {
      const { user } = show({ receiveToken: async () => ({ amount: 8, fee: 0 }) }, language);
      await user.click(screen.getByTestId("wallet-send"));
      await user.click(screen.getByTestId("wallet-pay-input"));
      await user.paste(TOKEN);
      expect(said().every((text) => text === "")).toBe(true);
      const redeem = submit();
      redeem.focus();
      await user.keyboard("{Enter}");

      const notice = await screen.findByTestId("wallet-notice");
      expect(notice.textContent).toBe(words.redeemed);
      // One live region says it: Send's own status line, there before the redeem. The visible line is not a second one.
      await waitFor(() => expect(said().filter((text) => text === words.redeemed)).toHaveLength(1));
      expect(said().filter((text) => text !== "")).toEqual([words.redeemed]);
      expect(notice).not.toHaveAttribute("role");
      expect(live(notice)).toBeNull();

      // The keys are not left on the button that turned into an unavailable Pay: the emptied field has them.
      const field = screen.getByTestId("wallet-pay-input");
      await waitFor(() => expect(field).toHaveFocus());
      expect(field).toHaveValue("");
      expect(document.activeElement?.getAttribute("aria-disabled")).toBeNull();
    });

    it(`${language}: a payment the mint left pending reads as waiting, says what comes next, and never as paid`, async () => {
      const { user } = show({ quoteInvoice: async () => ({ quote: "q-1", mint: TEST_MINT, amount: 5, feeReserve: 1 }), payQuote: async () => false }, language, { setAside: 6 } as Partial<WalletState>);
      await user.click(screen.getByTestId("wallet-send"));
      await user.click(screen.getByTestId("wallet-pay-input"));
      await user.paste(REGTEST_INVOICE);
      const quoteIt = submit();
      quoteIt.focus();
      await user.keyboard("{Enter}");
      const pay = await screen.findByTestId("wallet-pay-confirm");
      pay.focus();
      await user.keyboard("{Enter}");

      const notice = await screen.findByTestId("wallet-notice");
      expect(notice).toHaveAttribute("data-tone", "wait");
      expect(screen.getByTestId("wallet-notice-title").textContent).toBe(words.pending);
      expect(screen.getByTestId("wallet-notice-next").textContent).toBe(words.next);
      expect(said().filter((text) => text !== "")).toEqual([`${words.pending} ${words.next}`]);
      // Nothing of a paid result: no check mark drawn above it.
      expect(screen.getByTestId("wallet-send-result").querySelector("svg")).toBeNull();
      await waitFor(() => expect(screen.getByTestId("wallet-send-done")).toHaveFocus());
      // The line it points to is there: the set-aside amount under the balance.
      expect(screen.getByTestId("wallet-set-aside").textContent).toBe(words.setAside);
    });
  }

  it("en: a paid payment keeps its success line and its check mark", async () => {
    const { user } = show({ quoteInvoice: async () => ({ quote: "q-1", mint: TEST_MINT, amount: 5, feeReserve: 1 }), payQuote: async () => true }, "en");
    await user.click(screen.getByTestId("wallet-send"));
    await user.click(screen.getByTestId("wallet-pay-input"));
    await user.paste(REGTEST_INVOICE);
    submit().focus();
    await user.keyboard("{Enter}");
    (await screen.findByTestId("wallet-pay-confirm")).focus();
    await user.keyboard("{Enter}");
    const notice = await screen.findByTestId("wallet-notice");
    expect(notice).toHaveAttribute("data-tone", "success");
    expect(notice.textContent).toBe("Paid.");
    expect(screen.queryByTestId("wallet-notice-next")).toBeNull();
    expect(said().filter((text) => text !== "")).toEqual(["Paid."]);
    expect(screen.getByTestId("wallet-send-result").querySelector("svg")).not.toBeNull();
  });
});
