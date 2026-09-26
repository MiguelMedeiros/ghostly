import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { WalletNetwork } from "@ghostly/core";
import type { WalletAwaitingView, WalletView } from "@ghostly/browser/shared/types";
import { Wallet } from "../../pages/Wallet";
import { walletView } from "../fakeEngine";
import { renderApp } from "../render";
import { arkReady, lightningSource, mint, REAL_MINT, TEST_MINT } from "../payments/fixtures";

// covers: wallet.instances.remove

/** Opens the Wallets page on one card, and its Remove dialog. */
async function removing(wallet: WalletView, card: string) {
  const app = renderApp(<Wallet />);
  app.engine.update({ wallet });
  await app.user.click(await screen.findByTestId(`wallet-card-${card}`));
  await app.user.click(await screen.findByTestId("wallet-remove"));
  return { ...app, dialog: screen.getByTestId("wallet-remove-dialog") };
}

/** The view, with what one network's wallets still wait for (the engine reads it from quotes, journals and payments). */
function awaitingOn(wallet: WalletView, network: WalletNetwork, awaiting: WalletAwaitingView[]): WalletView {
  return { ...wallet, networks: { ...wallet.networks!, [network]: { ...wallet.networks![network], awaiting } } };
}

describe("Remove, in a wallet's details", () => {
  it("an empty Testnet wallet goes on one plain confirm; the next card of its network comes up", async () => {
    const { user, engine, dialog } = await removing(walletView({ mints: [mint(TEST_MINT, 0)], ark: arkReady({ balance: 0 }) }), "arkade-testnet");
    expect(within(dialog).getByRole("heading")).toHaveTextContent("Remove your Testnet Ark wallet?");
    expect(within(dialog).getByTestId("wallet-remove-network")).toHaveTextContent("Test money");
    expect(within(dialog).getByTestId("wallet-remove-held")).toHaveTextContent("It holds nothing.");
    // Nothing to lose: no backup step, no checkbox.
    expect(within(dialog).queryByTestId("wallet-remove-backup")).not.toBeInTheDocument();
    expect(within(dialog).queryByTestId("wallet-remove-understood")).not.toBeInTheDocument();
    engine.on("walletRemove", () => { engine.update({ wallet: walletView({ mints: [mint(TEST_MINT, 0)] }) }); });
    await user.click(within(dialog).getByTestId("wallet-remove-confirm"));
    expect(engine.callsTo("walletRemove")).toEqual([{ type: "arkade", network: "testnet" }]);
    await waitFor(() => expect(screen.queryByTestId("wallet-remove-dialog")).not.toBeInTheDocument());
    expect(screen.queryByTestId("wallet-card-arkade-testnet")).not.toBeInTheDocument();
    expect(await screen.findByTestId("wallet-card-cashu-testnet")).toHaveAttribute("aria-selected", "true");
  });

  it("a funded Mainnet wallet says how much, offers its backup, and asks in words that the money becomes unreachable", async () => {
    const { user, engine, dialog } = await removing(walletView({ mints: [mint(REAL_MINT, 21_000)], balance: 21_000 }), "cashu-mainnet");
    expect(within(dialog).getByTestId("wallet-remove-network")).toHaveTextContent("Real money");
    expect(within(dialog).getByTestId("wallet-remove-held")).toHaveTextContent("It holds 21,000 sats on Mainnet, real money.");
    // Cashu's backup is its ecash, as tokens.
    engine.on("walletExport", () => [{ mint: REAL_MINT, token: "cashuBfixture", amount: 21_000 }]);
    await user.click(within(dialog).getByTestId("wallet-remove-copy-tokens"));
    expect(engine.callsTo("walletExport")).toEqual([{ network: "mainnet" }]);
    expect(await within(dialog).findByTestId("wallet-remove-notice")).toHaveTextContent("Ecash copied");
    const confirm = within(dialog).getByTestId("wallet-remove-confirm");
    expect(confirm).toBeDisabled();
    expect(within(dialog).getByTestId("wallet-remove-consent")).toHaveTextContent("I understand: these 21,000 sats are real money, and they become unreachable without this wallet's backup.");
    await user.click(within(dialog).getByTestId("wallet-remove-understood"));
    expect(confirm).toBeEnabled();
    engine.on("walletRemove", () => undefined);
    await user.click(confirm);
    expect(engine.callsTo("walletRemove")).toEqual([{ type: "cashu", network: "mainnet", acceptLoss: true }]);
  });

  it("a wallet with a recovery phrase offers it, hidden until asked for, and its backup file", async () => {
    const { user, engine, dialog } = await removing(walletView({ ark: arkReady({ network: "bitcoin", balance: 5_000 }) }), "arkade-mainnet");
    const backup = within(dialog).getByTestId("wallet-remove-backup");
    expect(backup).toHaveTextContent("Recovery phrase");
    expect(backup).toHaveTextContent("Wallet backup");
    expect(backup).not.toHaveTextContent("Restore");
    expect(within(backup).queryByTestId("ark-recovery")).not.toBeInTheDocument();
    engine.on("arkBackup", () => ({ mnemonic: "fixture words only for this test", config: { network: "bitcoin", provider: "https://arkade.computer", explorer: "https://mempool.space/api", walletId: "w", serverKey: "02ab" } }));
    await user.click(within(backup).getByRole("button", { name: "Show" }));
    expect(engine.callsTo("arkBackup")).toEqual([{ network: "mainnet" }]);
    expect(await within(backup).findByTestId("ark-recovery")).toHaveTextContent("fixture words only for this test");
    await user.click(within(backup).getByRole("button", { name: "Hide" }));
    expect(within(backup).queryByTestId("ark-recovery")).not.toBeInTheDocument();
  });

  it("a wallet not connected may hold money: the confirmation says so", async () => {
    const { dialog } = await removing(walletView({ ark: arkReady({ locked: true, balance: 0 }) }), "arkade-testnet");
    expect(within(dialog).getByTestId("wallet-remove-held")).toHaveTextContent("Ghostly cannot read its balance right now (it is not connected): it may hold money.");
    expect(within(dialog).getByTestId("wallet-remove-consent")).toHaveTextContent("whatever this Testnet Ark wallet holds becomes unreachable without its backup");
    expect(within(dialog).getByTestId("wallet-remove-confirm")).toBeDisabled();
  });

  it("a source whose money is elsewhere only forgets the way there: no funds question", async () => {
    const { user, engine, dialog } = await removing(walletView({ mints: [mint(TEST_MINT, 0)], lightning: lightningSource({ mode: "testnet", providerId: "nwc", label: "NWC", alias: "Alby Hub", balance: 800, status: "ready" }) }), "lightning-testnet");
    expect(within(dialog).getByTestId("wallet-remove-held")).toHaveTextContent("Your money stays in Alby Hub: Ghostly only forgets how to reach it.");
    expect(within(dialog).queryByTestId("wallet-remove-understood")).not.toBeInTheDocument();
    engine.on("walletRemove", () => undefined);
    await user.click(within(dialog).getByTestId("wallet-remove-confirm"));
    expect(engine.callsTo("walletRemove")).toEqual([{ type: "lightning", network: "testnet" }]);
  });

  it("Lightning through the mints comes with Cashu: it points there instead of removing on its own", async () => {
    const { user, engine } = renderApp(<Wallet />);
    engine.update({ wallet: walletView({ mints: [mint(TEST_MINT, 0)] }) });
    await user.click(await screen.findByTestId("wallet-card-lightning-testnet"));
    const section = await screen.findByTestId("wallet-remove-section");
    expect(within(section).queryByTestId("wallet-remove")).not.toBeInTheDocument();
    expect(section).toHaveTextContent("This card comes with your Testnet Cashu wallet");
    await user.click(within(section).getByTestId("wallet-remove-open-cashu"));
    expect(screen.getByTestId("wallet-card-cashu-testnet")).toHaveAttribute("aria-selected", "true");
  });

  it("a Mainnet wallet holding nothing that still waits for money lists it, says it is lost afterwards, and asks in words", async () => {
    const wallet = awaitingOn(walletView({ mints: [mint(REAL_MINT, 0)], balance: 0 }), "mainnet", [
      { type: "cashu", kind: "request", amount: 50_000, paymentId: "r1" },
      { type: "cashu", kind: "paid", amount: 700 },
      { type: "cashu", kind: "sent", amount: 21, paymentId: "p1" },
      { type: "arkade", kind: "request", amount: 9, paymentId: "someone-else" },
    ]);
    const { user, engine, dialog } = await removing(wallet, "cashu-mainnet");
    expect(within(dialog).getByTestId("wallet-remove-held")).toHaveTextContent("It holds nothing.");
    expect(within(dialog).getAllByTestId("wallet-remove-awaiting-item").map((i) => [i.dataset.kind, i.textContent])).toEqual([
      ["request", "A request for 50,000 sats in a chat, still open"],
      ["paid", "700 sats paid to an invoice, not claimed from the mint yet"],
    ]);
    expect(within(dialog).getByTestId("wallet-remove-awaiting-note")).toHaveTextContent("Removing the wallet closes its open requests, and your contacts are told. Anything paid to them afterwards is lost: this is real money.");
    expect(within(dialog).getByTestId("wallet-remove-returnable")).toHaveTextContent("Ecash you sent from this wallet has not been taken yet (21 sats). It is not lost: to take it back later, add its mint again first.");
    // Money may still come to it: its backup is offered, and the loss is confirmed in words.
    expect(within(dialog).getByTestId("wallet-remove-backup")).toBeInTheDocument();
    expect(within(dialog).getByTestId("wallet-remove-consent")).toHaveTextContent("I understand: anything paid to its open requests and invoices after it is removed is lost, and it is real money.");
    const confirm = within(dialog).getByTestId("wallet-remove-confirm");
    expect(confirm).toBeDisabled();
    await user.click(within(dialog).getByTestId("wallet-remove-understood"));
    engine.on("walletRemove", () => undefined);
    await user.click(confirm);
    expect(engine.callsTo("walletRemove")).toEqual([{ type: "cashu", network: "mainnet", acceptLoss: true }]);
  });

  it("a source whose money is elsewhere lists its open requests, which close, and asks nothing about funds", async () => {
    const wallet = awaitingOn(walletView({ mints: [mint(TEST_MINT, 0)], lightning: lightningSource({ mode: "testnet", providerId: "nwc", label: "NWC", alias: "Alby Hub", balance: 800, status: "ready" }) }), "testnet", [{ type: "lightning", kind: "request", amount: 1_000, paymentId: "r1" }]);
    const { dialog } = await removing(wallet, "lightning-testnet");
    expect(within(dialog).getByTestId("wallet-remove-awaiting")).toHaveTextContent("A request for 1,000 test sats in a chat, still open");
    expect(within(dialog).getByTestId("wallet-remove-awaiting-note")).toHaveTextContent("Anything paid to them afterwards still reaches Alby Hub; Ghostly just no longer sees it.");
    expect(within(dialog).queryByTestId("wallet-remove-understood")).not.toBeInTheDocument();
    expect(within(dialog).getByTestId("wallet-remove-confirm")).toBeEnabled();
  });

  it("an unfinished payment stops it", async () => {
    const pending = { id: "p1", method: "arkade", network: "mutinynet", provider: "https://mutinynet.arkade.sh", asset: "BTC", unit: "sat", address: "tark1you", expiresAt: 1, payee: "you", amount: 10, fee: 0, feeCap: 100, createdAt: 1, state: "submitted" } as const;
    const { dialog } = await removing(walletView({ ark: arkReady({ balance: 0 }), intents: [pending] }), "arkade-testnet");
    expect(within(dialog).getByTestId("wallet-remove-pending")).toHaveTextContent("A payment through this wallet is not finished yet (1).");
    expect(within(dialog).getByTestId("wallet-remove-confirm")).toBeDisabled();
  });

  it("what the engine refuses is said once, and the dialog stays", async () => {
    const { user, engine, dialog } = await removing(walletView({ mints: [mint(TEST_MINT, 0)] }), "cashu-testnet");
    engine.on("walletRemove", () => { throw new Error("A Lightning payment from this wallet is still in flight: wait for it to settle, then remove the wallet."); });
    await user.click(within(dialog).getByTestId("wallet-remove-confirm"));
    expect(await within(dialog).findByTestId("wallet-remove-error")).toHaveTextContent("still in flight");
    expect(screen.getAllByTestId("wallet-remove-error")).toHaveLength(1);
    expect(screen.getByTestId("wallet-remove-dialog")).toBeInTheDocument();
  });

  it("Escape and Cancel close it, removing nothing", async () => {
    const { user, engine, dialog } = await removing(walletView({ ark: arkReady({ balance: 0 }) }), "arkade-testnet");
    await user.click(within(dialog).getByTestId("wallet-remove-cancel"));
    expect(screen.queryByTestId("wallet-remove-dialog")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("wallet-remove"));
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("wallet-remove-dialog")).not.toBeInTheDocument();
    expect(engine.callsTo("walletRemove")).toEqual([]);
  });
});
