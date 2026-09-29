import { act, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AccountBar } from "../../components/AccountBar";
import { MobileTabBar } from "../../components/MobileTabBar";
import { fakeEngine, walletView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: wallet.badge, app.responsive

const arrive = (balance: number, mode: "mainnet" | "testnet" = "mainnet") => act(() => fakeEngine.update({ wallet: walletView({ mode, balance }) }));

/** Sats that came in while the wallet was closed: a dot on the wallet icon, the amount only in its name and tooltip. */
describe("the wallet's new-sats dot", () => {
  it("real sats: a filled dot, the amount in the name and tooltip, no number on the bar", () => {
    renderApp(<AccountBar />);
    expect(screen.queryByTestId("wallet-new")).not.toBeInTheDocument();
    expect(screen.getByTestId("wallet-chip")).toHaveAccessibleName("Wallets");

    arrive(109_100);
    const dot = screen.getByTestId("wallet-new");
    expect(dot).toHaveClass("nav-dot");
    expect(dot).not.toHaveClass("nav-dot-test");
    expect(dot).toBeEmptyDOMElement();
    expect(screen.getByTestId("wallet-chip")).toHaveAccessibleName("Wallets, 109,100 new sats");
    expect(screen.getByTestId("wallet-chip")).toHaveAttribute("title", "Wallets, 109,100 new sats");
    expect(screen.getByTestId("account-bar")).not.toHaveTextContent(/\d/);
  });

  it("test sats only: the same dot, hollow, and the name says test sats", () => {
    renderApp(<AccountBar />);
    arrive(21, "testnet");
    expect(screen.getByTestId("wallet-new")).toHaveClass("nav-dot", "nav-dot-test");
    expect(screen.getByTestId("wallet-chip")).toHaveAccessibleName("Wallets, 21 new test sats");
  });

  it("goes once the Wallets page opens, and nothing shows for sats that arrive there", async () => {
    const { user } = renderApp(<AccountBar />);
    arrive(500);
    await user.click(screen.getByTestId("wallet-chip"));
    expect(screen.queryByTestId("wallet-new")).not.toBeInTheDocument();
    arrive(900);
    expect(screen.queryByTestId("wallet-new")).not.toBeInTheDocument();
    expect(screen.getByTestId("wallet-chip")).toHaveAccessibleName("Wallets");
  });

  it("on a phone: the Wallets tab carries it, counting what came in while a chat hid the tab bar", () => {
    const { unmount } = renderApp(<MobileTabBar />);
    unmount();
    arrive(2_000);
    renderApp(<MobileTabBar />);
    const dot = screen.getByTestId("wallet-new");
    expect(dot).toHaveClass("nav-dot", "nav-dot-tab");
    expect(screen.getByTestId("mobile-tab-wallet")).toHaveAccessibleName("Wallets, 2,000 new sats");
    expect(screen.getByTestId("mobile-tabs")).not.toHaveTextContent(/\d/);
  });
});
