import { act, screen, waitFor } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { AccountBar } from "../../components/AccountBar";
import { MobileTabBar } from "../../components/MobileTabBar";
import { Wallet } from "../../pages/Wallet";
import { fakeEngine, walletView } from "../fakeEngine";
import { renderApp } from "../render";
import { mint, REAL_MINT } from "../payments/fixtures";

// covers: wallet.badge, app.responsive

const arrive = (balance: number, mode: "mainnet" | "testnet" = "mainnet") => act(() => fakeEngine.update({ wallet: walletView({ mode, balance }) }));

describe("the wallets read as the app starts", () => {
  it("are not new sats", () => {
    // As the engine starts: its empty view first (no networks yet), then the wallets read from the device.
    fakeEngine.emit({ kind: "state", state: { ...fakeEngine.state, wallet: { mints: [], balance: 0, history: [], feesPaid: 0 } } });
    renderApp(<AccountBar />);
    arrive(109_100);
    expect(screen.queryByTestId("wallet-new")).not.toBeInTheDocument();
    expect(screen.getByTestId("wallet-chip")).toHaveAccessibleName("Wallets");
    arrive(110_000);
    expect(screen.getByTestId("wallet-chip")).toHaveAccessibleName("Wallets, 900 new sats");
  });
});

/** Sats that came in while the wallet was closed: a dot on the wallet icon, the amount only in its name and tooltip. */
describe("the wallet's new-sats dot", () => {
  // The wallets as read when the app started: empty.
  beforeEach(() => { fakeEngine.update({ wallet: walletView() }); });

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

  it("says it in the app's language and number format, test sats as test sats", () => {
    renderApp(<AccountBar />, { language: "pt" });
    arrive(1_500, "testnet");
    expect(screen.getByTestId("wallet-chip")).toHaveAccessibleName(/, 1\.500 sats de teste novos$/);
    expect(screen.getByTestId("wallet-chip")).not.toHaveAccessibleName(/new/);
  });

  it("stays while the Wallets page shows their network, goes once it is left; nothing shows for sats that arrive there", async () => {
    // A Mainnet Cashu wallet: the page opens on Mainnet.
    const cashu = (sats: number) => act(() => fakeEngine.update({ wallet: walletView({ mints: [mint(REAL_MINT, sats)], balance: sats }) }));
    fakeEngine.update({ wallet: walletView({ mints: [mint(REAL_MINT, 0)] }) });
    const { user } = renderApp(<><AccountBar /><Routes><Route path="/wallet" element={<Wallet />} /><Route path="*" element={null} /></Routes></>);
    cashu(500);
    await user.click(screen.getByTestId("wallet-chip"));
    expect(screen.getByTestId("wallet-new")).toBeInTheDocument();
    cashu(900);
    expect(screen.getByTestId("wallet-chip")).toHaveAccessibleName("Wallets, 500 new sats");
    await user.click(screen.getByTestId("wallet-chip"));
    await waitFor(() => expect(screen.queryByTestId("wallet-new")).not.toBeInTheDocument());
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
