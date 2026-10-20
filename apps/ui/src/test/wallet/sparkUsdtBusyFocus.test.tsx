import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { PaymentReview as Review } from "@ghostly/core";
import { SparkWalletPanel } from "../../components/SparkWalletPanel";
import { UsdtWalletPanel } from "../../components/UsdtWalletPanel";
import { networkState } from "../../components/walletCardData";
import { servicesPlatform, type WalletPlatform, type WalletState } from "../../lib/platform";
import { walletView } from "../fakeEngine";
import { sparkReady, usdtReady } from "../payments/fixtures";
import { renderApp } from "../render";

// covers: wallet.spark.send, wallet.spark.lightning, wallet.spark.mainnet-key, wallet.usdt.send

/**
 * The Spark and USDT panels from the keyboard: the button pressed keeps the focus while it works (busy, not disabled:
 * a disabled one drops it to the page in Chromium) and after a refusal; the panel's other buttons wait, disabled. A
 * Review payment hands the focus to the review it opens.
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

/** A Spark address on Breez's regtest (as sparkPanel.test.tsx has it). */
const SPARK_ADDRESS = "sparkrt1pgss87y4e569hncpt9649q5s6x7c3vv9lqwrjlucxfl3a3kk355a3pfkwf2mtr";

describe("the Spark panel", () => {
  it("Review payment is busy where pressed and keeps the keys after a refusal; the review it opens takes them", async () => {
    let prepared = later<Review>();
    const wallet = withMethods({ preparePayment: () => prepared.promise });
    const { user } = renderApp(<SparkWalletPanel wallet={wallet} state={onTestnet({ spark: sparkReady() })} />);
    await user.click(screen.getByRole("tab", { name: "Send" }));
    await user.type(screen.getByLabelText("Spark address or invoice"), SPARK_ADDRESS);
    await user.type(screen.getByTestId("spark-amount"), "21");
    const open = screen.getByTestId("spark-review");
    await press(user, open);
    busy(open);
    prepared.refuse(new Error("Not enough"));
    await done(open);
    expect(open).toHaveFocus();

    prepared = later();
    await user.keyboard("{Enter}");
    prepared.answer(review("spark", "regtest"));
    await waitFor(() => expect(screen.getByRole("heading", { name: /Review payment/ })).toHaveFocus());
  });

  it("Use for Lightning too is busy where pressed and keeps the keys after a refusal", async () => {
    const used = later<void>();
    const wallet = withMethods({ sparkUseForLightning: () => used.promise as never });
    const { user } = renderApp(<SparkWalletPanel wallet={wallet} state={onTestnet({ spark: sparkReady() })} />);
    const use = screen.getByTestId("spark-use-lightning");
    await press(user, use);
    busy(use);
    used.refuse(new Error("Breez did not answer"));
    await done(use);
    expect(use).toHaveFocus();
  });

  it("Open a Mainnet Spark wallet is busy where pressed and keeps the keys after a refusal", async () => {
    const created = later<void>();
    const wallet = withMethods({ sparkCreate: () => created.promise as never });
    const state = walletView({ spark: { configured: false, locked: true, balance: 0, network: "bitcoin", needsKey: true, unavailable: "key" } }) as WalletState;
    const { user } = renderApp(<SparkWalletPanel wallet={wallet} state={state} />);
    await user.type(screen.getByLabelText("Breez API key"), "breez-key");
    const create = screen.getByTestId("spark-mainnet-create");
    await press(user, create);
    busy(create);
    created.refuse(new Error("The key was refused"));
    await done(create);
    expect(create).toHaveFocus();
  });
});

describe("the USDT panel", () => {
  it("Unlock USDT is busy where pressed and keeps the keys after a refusal", async () => {
    const unlocked = later<void>();
    const wallet = withMethods({ usdtUnlock: () => unlocked.promise as never });
    const { user } = renderApp(<UsdtWalletPanel wallet={wallet} state={onTestnet({ usdt: usdtReady({ locked: true, network: "sepolia" }) })} />);
    await user.type(screen.getByLabelText("USDT wallet password"), "secret");
    const unlock = screen.getByRole("button", { name: "Unlock USDT" });
    await press(user, unlock);
    busy(unlock);
    unlocked.refuse(new Error("Wrong password"));
    await done(unlock);
    expect(unlock).toHaveFocus();
  });

  it("Review payment is busy where pressed and keeps the keys after a refusal; the review it opens takes them", async () => {
    let prepared = later<Review>();
    const wallet = withMethods({ preparePayment: () => prepared.promise });
    const { user } = renderApp(<UsdtWalletPanel wallet={wallet} state={onTestnet({ usdt: usdtReady({ network: "sepolia", address: "0xme" }) })} />);
    await user.click(screen.getByRole("tab", { name: "Send" }));
    await user.type(screen.getByRole("textbox", { name: "USDT recipient address" }), "0xrecipient");
    await user.type(screen.getByRole("textbox", { name: /^Amount/ }), "2");
    const open = screen.getByRole("button", { name: "Review payment" });
    await press(user, open);
    busy(open);
    prepared.refuse(new Error("Gas too high"));
    await done(open);
    expect(open).toHaveFocus();

    prepared = later();
    await user.keyboard("{Enter}");
    prepared.answer(review("usdt", "sepolia"));
    await waitFor(() => expect(screen.getByRole("heading", { name: /Review payment/ })).toHaveFocus());
  });
});
