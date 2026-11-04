import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TEST_MINTS } from "@ghostly/browser/shared/mints";
import { CashuWallet } from "../../components/wallet/CashuWallet";
import { networkState } from "../../components/walletCardData";
import { servicesPlatform, type WalletPlatform, type WalletState } from "../../lib/platform";
import { walletView } from "../fakeEngine";
import { REGTEST_INVOICE, liveMainnetInvoice, mint, REAL_MINT } from "../payments/fixtures";
import { renderApp } from "../render";

// covers: wallet.cashu.receive-lightning, wallet.cashu.pay-invoice, payments.mainnet-confirm, wallet.instances.remove

/**
 * The Cashu card from the keyboard: the button pressed keeps the focus while it works (busy, not disabled: a disabled
 * one drops it to the page in Chromium) and after a refusal. A press while busy does nothing.
 */
describe("the Cashu card keeps the keyboard's place while it works", () => {
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
