import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { PaymentReview as Review } from "@ghostly/core";
import { ArkWalletPanel } from "../../components/ArkWalletPanel";
import { BarkWalletPanel } from "../../components/BarkWalletPanel";
import { BitcoinWalletPanel } from "../../components/BitcoinWalletPanel";
import { networkState } from "../../components/walletCardData";
import { servicesPlatform, type WalletPlatform, type WalletState } from "../../lib/platform";
import { walletView } from "../fakeEngine";
import { arkReady, barkReady, bitcoinSource } from "../payments/fixtures";
import { renderApp } from "../render";

// covers: wallet.onchain.bdk.send, wallet.onchain.sources, wallet.ark.recover, wallet.ark.send, wallet.bark.send, wallet.ark.boarding

/**
 * The Bitcoin, Ark and Bark panels from the keyboard: the button pressed keeps the focus while it works (busy, not
 * disabled: a disabled one drops it to the page in Chromium) and after a refusal; the panel's other buttons wait,
 * disabled. A Review payment hands the focus to the review it opens.
 */
const later = <T,>() => { let answer!: (value: T) => void, refuse!: (e: Error) => void; const promise = new Promise<T>((resolve, reject) => { answer = resolve; refuse = reject; }); return { promise, answer, refuse }; };
const busy = (button: HTMLElement) => {
  expect(button).toHaveAttribute("aria-busy", "true");
  expect(button).toHaveAttribute("aria-disabled", "true");
  expect(button).toBeEnabled();
  expect(button).toHaveFocus();
};
const done = (button: HTMLElement) => waitFor(() => expect(button).not.toHaveAttribute("aria-busy"));
const press = async (user: { keyboard(keys: string): Promise<void> }, button: HTMLElement) => { button.focus(); await user.keyboard("{Enter}"); };
const onTestnet = (patch: Partial<WalletState>) => networkState(walletView(patch) as WalletState, "testnet");
const withMethods = (methods: Partial<WalletPlatform>): WalletPlatform => Object.assign(Object.create(servicesPlatform!.wallet), methods);
const review = (method: Review["method"], network: string): Review =>
  ({ method, network, provider: "p", asset: "BTC", unit: "sat", address: "addr", expiresAt: Date.now() + 60_000, id: "review-1", payee: "addr", amount: 21, fee: 1, feeCap: 10, createdAt: 0, state: "pending" }) as Review;

describe("the Bitcoin panel", () => {
  it("Get an address is busy where pressed and keeps the keys after a refusal; Refresh now waits", async () => {
    const asked = later<string>();
    const wallet = withMethods({ bitcoinReceiveAddress: () => asked.promise as never });
    const { user } = renderApp(<BitcoinWalletPanel wallet={wallet} state={onTestnet({ bitcoin: bitcoinSource({ mode: "testnet" }) })} />);
    const get = screen.getByTestId("bitcoin-new-address");
    await press(user, get);
    busy(get);
    expect(screen.getByRole("button", { name: "Refresh now" })).toBeDisabled();
    asked.refuse(new Error("The node did not answer"));
    await done(get);
    expect(get).toHaveFocus();
  });

  it("Retry, not connected, is busy where pressed and keeps the keys after a refusal", async () => {
    const tried = later<void>();
    const wallet = withMethods({ bitcoinRetrySource: () => tried.promise });
    const { user } = renderApp(<BitcoinWalletPanel wallet={wallet} state={onTestnet({ bitcoin: bitcoinSource({ mode: "testnet", status: "error", label: "Electrum" }) })} />);
    const retry = screen.getByTestId("bitcoin-retry");
    await press(user, retry);
    busy(retry);
    tried.refuse(new Error("Still down"));
    await done(retry);
    expect(retry).toHaveFocus();
  });

  it("Review payment is busy where pressed and keeps the keys after a refusal; the review it opens takes them", async () => {
    let prepared = later<Review>();
    const wallet = withMethods({ preparePayment: () => prepared.promise });
    const { user } = renderApp(<BitcoinWalletPanel wallet={wallet} state={onTestnet({ bitcoin: bitcoinSource({ mode: "testnet" }) })} />);
    await user.click(screen.getByRole("tab", { name: "Send" }));
    await user.type(screen.getByRole("textbox", { name: "Bitcoin recipient address" }), "tb1qrecipient");
    await user.type(screen.getByTestId("bitcoin-amount"), "21");
    const open = screen.getByRole("button", { name: "Review payment" });
    await press(user, open);
    busy(open);
    prepared.refuse(new Error("Fee too high"));
    await done(open);
    expect(open).toHaveFocus();

    prepared = later();
    await user.keyboard("{Enter}");
    prepared.answer(review("bitcoin", "signet"));
    await waitFor(() => expect(screen.getByRole("heading", { name: /Review payment/ })).toHaveFocus());
  });
});

describe("the Ark panel", () => {
  it("Recover is busy where pressed and keeps the keys after a refusal", async () => {
    const recovered = later<void>();
    const wallet = withMethods({ arkRecover: () => recovered.promise as never });
    const { user } = renderApp(<ArkWalletPanel wallet={wallet} state={onTestnet({ ark: arkReady({ recoverable: 900 }) })} />);
    const recover = screen.getByTestId("ark-recover");
    await press(user, recover);
    busy(recover);
    recovered.refuse(new Error("The server did not answer"));
    await done(recover);
    expect(recover).toHaveFocus();
  });

  it("Review payment is busy where pressed; the review it opens takes the keys", async () => {
    const prepared = later<Review>();
    const wallet = withMethods({ preparePayment: () => prepared.promise });
    const { user } = renderApp(<ArkWalletPanel wallet={wallet} state={onTestnet({ ark: arkReady({ provider: "https://ark.example" }) })} />);
    await user.click(screen.getByRole("tab", { name: "Send" }));
    await user.type(screen.getByRole("textbox", { name: "Ark recipient address" }), "tark1recipient");
    await user.type(screen.getByRole("textbox", { name: /^Amount/ }), "21");
    const open = screen.getByRole("button", { name: "Review payment" });
    await press(user, open);
    busy(open);
    prepared.answer(review("arkade", "mutinynet"));
    await waitFor(() => expect(screen.getByRole("heading", { name: /Review payment/ })).toHaveFocus());
  });
});

describe("the Bark panel", () => {
  it("Move into Ark is busy where pressed and keeps the keys after a refusal", async () => {
    const boarded = later<void>();
    const wallet = withMethods({ barkBoard: () => boarded.promise as never });
    const { user } = renderApp(<BarkWalletPanel wallet={wallet} state={onTestnet({ bark: barkReady({ onchain: 5_000 }) })} />);
    const board = screen.getByTestId("bark-board");
    await press(user, board);
    busy(board);
    expect(board).toHaveTextContent("Moving…");
    boarded.refuse(new Error("The server did not answer"));
    await done(board);
    expect(board).toHaveFocus();
  });

  it("Review payment is busy where pressed; the review it opens takes the keys", async () => {
    const prepared = later<Review>();
    const wallet = withMethods({ preparePayment: () => prepared.promise });
    const { user } = renderApp(<BarkWalletPanel wallet={wallet} state={onTestnet({ bark: barkReady({ provider: "https://bark.example" }) })} />);
    await user.click(screen.getByRole("tab", { name: "Send" }));
    await user.type(screen.getByRole("textbox", { name: "Bark recipient address" }), "tark1recipient");
    await user.type(screen.getByRole("textbox", { name: /^Amount/ }), "21");
    const open = screen.getByRole("button", { name: "Review payment" });
    await press(user, open);
    busy(open);
    prepared.answer(review("bark", "signet"));
    await waitFor(() => expect(screen.getByRole("heading", { name: /Review payment/ })).toHaveFocus());
  });
});
