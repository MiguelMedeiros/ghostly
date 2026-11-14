import { act, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { WalletOffer, WalletSetupView } from "@ghostly/browser/shared/types";
import { Wallet } from "../../pages/Wallet";
import { walletView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: wallet.instances.first-run

/*
 * A new profile's Mainnet wallets that could not be made, on the Wallet page: Try again and Skip pressed from the
 * keyboard. The focus stays on Try again while it works and after it fails again, and once a row goes (skipped, or
 * made) it moves to the next row's Try again, or to New when none is left. A disabled button, or one that goes, dropped
 * a keyboard's focus to the page in Chrome and WebKit, and the next Tab started from the top.
 */

/** What Chrome and WebKit do to a focused button that turns disabled: they take its focus away. happy-dom keeps it. */
function browserDropsFocus() {
  const active = document.activeElement;
  if (active instanceof HTMLButtonElement && active.disabled) act(() => { active.disabled = false; active.blur(); active.disabled = true; });
}

const offers = (): WalletOffer[] => (["cashu", "usdt"] as const).flatMap((type) => (["mainnet", "testnet"] as const).map((network) => ({ type, network, available: true })));
const failed = (...types: ("cashu" | "usdt")[]): WalletSetupView["failed"] =>
  types.map((type) => ({ type, network: "mainnet", reason: `Could not reach ${type === "cashu" ? "mint.example" : "rpc.example"}` }));

function setup(view: WalletSetupView) {
  const rendered = renderApp(<Wallet />);
  const show = (next: WalletSetupView) => act(() => { rendered.engine.update({ wallet: walletView({ offers: offers(), setup: next }) }); });
  show(view);
  return { ...rendered, show };
}

describe("the first-run wallet setup's Try again and Skip, from the keyboard", () => {
  it("Try again keeps the focus while it runs, and has it again when it fails again", async () => {
    let done: () => void = () => {};
    const { user, engine, show } = setup({ running: false, failed: failed("cashu", "usdt") });
    engine.on("walletSetupRetry", () => new Promise<void>((resolve) => { done = resolve; }));
    const retry = await screen.findByTestId("wallet-setup-retry-cashu");
    retry.focus();
    await user.keyboard("{Enter}");
    // The engine says the run is under way.
    show({ running: true, failed: failed("cashu", "usdt") });
    await waitFor(() => expect(retry).toHaveTextContent("Creating"));
    browserDropsFocus();
    expect(retry).toHaveFocus();
    expect(retry).toHaveAttribute("aria-busy", "true");
    // It failed again: the row stays, Try again with it.
    show({ running: false, failed: failed("cashu", "usdt") });
    await act(async () => done());
    browserDropsFocus();
    expect(screen.getByTestId("wallet-setup-retry-cashu")).toHaveFocus();
    expect(engine.callsTo("walletSetupRetry")).toEqual([{ type: "cashu" }]);
  });

  it("Skip moves the focus to the next row's Try again, and the last one to New", async () => {
    const { user, engine, show } = setup({ running: false, failed: failed("cashu", "usdt") });
    engine.on("walletSetupDismiss", ({ type }) => { show({ running: false, failed: failed(...(["cashu", "usdt"] as const).filter((t) => t !== type && !engine.callsTo("walletSetupDismiss").some((c) => c.type === t))) }); });
    (await screen.findByTestId("wallet-setup-skip-cashu")).focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByTestId("wallet-setup-skip-cashu")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId("wallet-setup-retry-usdt")).toHaveFocus());

    screen.getByTestId("wallet-setup-skip-usdt").focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByTestId("wallet-setup")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId("wallet-add")).toHaveFocus());
  });

  it("a Try again that makes the wallet moves the focus on, as Skip does", async () => {
    const { user, engine, show } = setup({ running: false, failed: failed("cashu") });
    engine.on("walletSetupRetry", () => { show({ running: false, failed: [] }); });
    (await screen.findByTestId("wallet-setup-retry-cashu")).focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByTestId("wallet-setup")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId("wallet-add")).toHaveFocus());
  });
});
