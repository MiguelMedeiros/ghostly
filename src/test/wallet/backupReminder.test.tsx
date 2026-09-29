import { act, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Route, Routes, useLocation } from "react-router-dom";
import type { WalletView } from "@ghostly/browser/shared/types";
import type { BackupReminders } from "@ghostly/browser/shared/backupReminder";
import { Wallet } from "../../pages/Wallet";
import { AccountBar } from "../../components/AccountBar";
import { MobileTabBar } from "../../components/MobileTabBar";
import { ProfileBackups } from "../../components/ProfileBackups";
import { walletView } from "../fakeEngine";
import { renderApp } from "../render";
import { mint, REAL_MINT, TEST_MINT, usdtReady } from "../payments/fixtures";

// covers: wallet.backup-reminder

const funded = (at = Date.now() - 1000) => ({ funded: at });
/** Mainnet Cashu with 50 sats and Mainnet USDT with 5 USDT, and the reminders the engine keeps for them. */
const real = (backupReminders: BackupReminders): WalletView => walletView({ mints: [mint(REAL_MINT, 50)], usdt: usdtReady({ chainId: 1, network: "ethereum" }), backupReminders });

/** Where the app went: the page it is on and the state it carried. */
function Probe() {
  const location = useLocation();
  return <p data-testid="probe">{location.pathname} {JSON.stringify(location.state)}</p>;
}
function openWallet(wallet: WalletView) {
  const app = renderApp(<Routes><Route path="/wallet" element={<Wallet />} /><Route path="*" element={<Probe />} /></Routes>, { route: "/wallet" });
  act(() => app.engine.update({ wallet }));
  return app;
}

describe("the backup reminder on the Wallet page", () => {
  it("Cashu with real money: one calm card, its button opens the profile's backups", async () => {
    const { user } = openWallet(real({ "cashu:mainnet": funded() }));
    const card = await screen.findByTestId("backup-reminder");
    expect(card).toHaveAttribute("data-wallet", "cashu:mainnet");
    expect(card).toHaveTextContent("You have real money in Cashu");
    expect(card).toHaveTextContent("Back it up so you don't lose it if this device is lost.");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // The why is behind the ⓘ.
    await user.click(screen.getByTestId("row-info"));
    expect(screen.getByTestId("row-info-text")).toHaveTextContent("Cashu has no recovery phrase");
    await user.click(screen.getByTestId("backup-reminder-go"));
    expect(await screen.findByTestId("probe")).toHaveTextContent(/^\/profile .*"backupProfile":true/);
  });

  it("USDT with real money: its button opens the wallet on its recovery phrase", async () => {
    const { user } = openWallet(real({ "usdt:mainnet": funded() }));
    const go = await screen.findByTestId("backup-reminder-go");
    expect(go).toHaveTextContent("Show recovery phrase");
    await user.click(go);
    await waitFor(() => expect(screen.getByTestId("usdt-recovery-show")).toHaveFocus());
    expect(screen.getByTestId("wallet-panel")).toHaveAttribute("data-network", "mainnet");
  });

  it("Later asks the engine to put that wallet off", async () => {
    const { user, engine } = openWallet(real({ "cashu:mainnet": funded() }));
    engine.on("walletBackupReminder", () => undefined);
    await user.click(await screen.findByTestId("backup-reminder-later"));
    expect(engine.callsTo("walletBackupReminder")).toEqual([{ event: "later", wallet: "cashu:mainnet" }]);
  });

  it("shows nothing once backed up, while put off, or for test coins", () => {
    const { engine } = openWallet(real({ "cashu:mainnet": { funded: 1, backedUp: 2 }, "usdt:mainnet": { funded: 1, later: Date.now(), laterBalance: "5000000", laters: 1 } }));
    expect(screen.queryByTestId("backup-reminder")).not.toBeInTheDocument();
    act(() => engine.update({ wallet: walletView({ mints: [mint(TEST_MINT, 10_000)], backupReminders: { "cashu:testnet": funded() } }) }));
    expect(screen.queryByTestId("backup-reminder")).not.toBeInTheDocument();
  });
});

describe("the wallet icon while a backup reminder asks", () => {
  it("wears a dot and says so in its name; the new-sats dot takes its place, one dot at most", () => {
    const { engine } = renderApp(<AccountBar />);
    expect(screen.queryByTestId("wallet-backup-due")).not.toBeInTheDocument();
    act(() => engine.update({ wallet: real({ "cashu:mainnet": funded() }) }));
    expect(screen.getByTestId("wallet-backup-due")).toHaveClass("nav-dot");
    expect(screen.getByTestId("wallet-chip")).toHaveAccessibleName(/^Wallets(, [\d,]+ new sats)?, backup needed$/);
    act(() => engine.update({ wallet: real({ "cashu:mainnet": { funded: 1, backedUp: 2 } }) }));
    expect(screen.queryByTestId("wallet-backup-due")).not.toBeInTheDocument();
  });

  it("on a phone, the Wallets tab carries it", () => {
    const { engine } = renderApp(<MobileTabBar />);
    act(() => engine.update({ wallet: real({ "usdt:mainnet": funded() }) }));
    expect(screen.getByTestId("mobile-tab-wallet")).toHaveAccessibleName(/backup needed$/);
    expect(document.querySelectorAll("[data-testid=wallet-backup-due], [data-testid=wallet-new]")).toHaveLength(1);
  });
});

describe("the profile's backups, reached from the reminder", () => {
  it("open on Back up, the passphrase in focus", async () => {
    renderApp(<ProfileBackups canSwitch={false} openBackup />);
    await waitFor(() => expect(screen.getByTestId("backup-passphrase")).toHaveFocus());
  });
});
