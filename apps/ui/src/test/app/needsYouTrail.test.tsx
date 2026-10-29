import { act, screen, waitFor, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PeekChat } from "@ghostly/browser/engine/profilePeek";
import type { BackupReminders } from "@ghostly/browser/shared/backupReminder";
import { Wallet } from "../../pages/Wallet";
import { Settings } from "../../pages/Settings";
import { AccountBar } from "../../components/AccountBar";
import { MobileTabBar } from "../../components/MobileTabBar";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { createProfile } from "../../lib/profiles";
import { mergePeek } from "../../lib/profilePeek";
import { fakeEngine, walletView } from "../fakeEngine";
import { renderApp } from "../render";
import { windowIs } from "../viewport";
import { mint, REAL_MINT, TEST_MINT } from "../payments/fixtures";

// covers: wallet.badge, wallet.backup-reminder, profiles.peek

/** Cashu on both networks: 50 real sats, `test` test sats; and the reminders the engine keeps. */
const wallets = (test: number, backupReminders?: BackupReminders) =>
  walletView({ mints: [mint(REAL_MINT, 50), mint(TEST_MINT, test)], ...(backupReminders && { backupReminders }) });

/** The sidebar and, beside it, the Wallets page or the chat list; the wallets as read when the app started. */
function openApp(wallet = wallets(10)) {
  fakeEngine.update({ wallet });
  return renderApp(<><AccountBar /><Routes><Route path="/wallet" element={<Wallet />} /><Route path="*" element={<p data-testid="home" />} /></Routes></>);
}

beforeEach(() => { localStorage.setItem("ghostly-wallet-network", "mainnet"); });

/**
 * A dot on a place leads to what needs the person: the place's page says what it is in one line, its network tab and
 * its card carry the dot too, and a new thing stays marked until it was seen there.
 */
describe("the Wallets dot's trail", () => {
  it("new test sats: the page says where they are, the Testnet tab and its Cashu card wear the dot, Show goes there", async () => {
    const { user } = openApp();
    act(() => fakeEngine.update({ wallet: wallets(31) }));
    expect(screen.getByTestId("wallet-new")).toBeInTheDocument();

    await user.click(screen.getByTestId("wallet-chip"));
    // On the Mainnet tab: the line at the top, and the Testnet tab marked.
    const list = await screen.findByTestId("needs-you");
    expect(within(list).getByTestId("needs-you-item")).toHaveTextContent("21 new test sats in Cashu");
    expect(within(screen.getByTestId("wallet-network-testnet")).getByTestId("needs-you-dot")).toBeInTheDocument();
    expect(within(screen.getByTestId("wallet-network-mainnet")).queryByTestId("needs-you-dot")).not.toBeInTheDocument();
    expect(screen.getByTestId("wallet-network-testnet")).toHaveAccessibleName(/needs a look$/);
    // Still there while the page is open: the bar's dot is the first step of the trail.
    expect(screen.getByTestId("wallet-new")).toBeInTheDocument();

    await user.click(within(list).getByRole("button", { name: /Show/ }));
    expect(screen.getByTestId("wallet-network-testnet")).toHaveAttribute("aria-selected", "true");
    const card = screen.getByTestId("wallet-card-cashu-testnet");
    expect(within(card).getByTestId("needs-you-dot")).toBeInTheDocument();
    expect(card).toHaveAccessibleName(/21 new test sats in Cashu/);

    // Seen: once the page is left, every step of it goes.
    await user.click(screen.getByTestId("wallet-chip"));
    await waitFor(() => expect(screen.queryByTestId("wallet-new")).not.toBeInTheDocument());
    await user.click(screen.getByTestId("wallet-chip"));
    expect(await screen.findByTestId("wallet-networks")).toBeInTheDocument();
    expect(screen.queryByTestId("needs-you")).not.toBeInTheDocument();
    expect(screen.queryByTestId("needs-you-dot")).not.toBeInTheDocument();
  });

  it("sats on a network never shown stay new after the page closes", async () => {
    const { user } = openApp();
    act(() => fakeEngine.update({ wallet: wallets(31) }));
    await user.click(screen.getByTestId("wallet-chip"));
    expect(await screen.findByTestId("needs-you")).toBeInTheDocument();
    await user.click(screen.getByTestId("wallet-chip"));
    expect(await screen.findByTestId("home")).toBeInTheDocument();
    expect(screen.getByTestId("wallet-new")).toBeInTheDocument();
  });

  it("a backup to make: listed, its card and Mainnet tab marked, and it stays until it is done", async () => {
    const { user } = openApp(wallets(10, { "cashu:mainnet": { funded: Date.now() - 1000 } }));
    await user.click(screen.getByTestId("wallet-chip"));
    const item = await screen.findByTestId("needs-you-item");
    expect(item).toHaveTextContent("Back up your Cashu wallet");
    expect(within(screen.getByTestId("wallet-network-mainnet")).getByTestId("needs-you-dot")).toBeInTheDocument();
    expect(within(screen.getByTestId("wallet-card-cashu-mainnet")).getByTestId("needs-you-dot")).toBeInTheDocument();
    await user.click(within(item).getByRole("button", { name: /Show/ }));
    expect(screen.getByTestId("backup-reminder-go")).toHaveFocus();

    // Looked at is not done: it is still there on the next visit.
    await user.click(screen.getByTestId("wallet-chip"));
    await user.click(screen.getByTestId("wallet-chip"));
    expect(await screen.findByTestId("needs-you-item")).toHaveTextContent("Back up your Cashu wallet");
    act(() => fakeEngine.update({ wallet: wallets(10, { "cashu:mainnet": { funded: 1, backedUp: 2 } }) }));
    expect(screen.queryByTestId("needs-you")).not.toBeInTheDocument();
    expect(screen.queryByTestId("needs-you-dot")).not.toBeInTheDocument();
  });
});

const peeked = (text: string): PeekChat => ({ linkId: "a", peer: "peer-a", peerSequence: 4, text, held: 0 });

describe("the Settings dot's trail on a phone", () => {
  beforeEach(() => {
    fakeEngine.features = { ...fakeEngine.features, profiles: true };
    windowIs(true);
  });
  afterEach(() => {
    fakeEngine.features = { ...fakeEngine.features, profiles: false };
    vi.restoreAllMocks();
  });

  it("new messages in another profile: Settings says so, its Switch profile row wears the dot, Show opens the switcher", async () => {
    const work = createProfile("Work");
    mergePeek(work.id, { chats: [peeked("t")] });
    const { user } = renderApp(<LockScreenProvider><UpdateProvider><Routes><Route path="*" element={<><Settings /><MobileTabBar /></>} /></Routes></UpdateProvider></LockScreenProvider>);
    expect(await screen.findByTestId("mobile-tab-profile-new")).toBeInTheDocument();
    const item = await screen.findByTestId("needs-you-item");
    expect(item).toHaveTextContent("New messages in another profile");
    const row = screen.getByTestId("settings-profile-switch");
    expect(within(row).getByTestId("needs-you-dot")).toBeInTheDocument();
    expect(row).toHaveTextContent("New messages in another profile");
    await user.click(within(item).getByRole("button", { name: /Show/ }));
    expect(within(await screen.findByRole("menu")).getAllByTestId("profile-switcher-item")[0]).toHaveAccessibleName("Switch to Work, new messages");
  });
});
