import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { WalletNetwork } from "@ghostly/core";
import type { WalletAwaitingView, WalletView } from "@ghostly/browser/shared/types";
import { Wallet } from "../../pages/Wallet";
import { walletView } from "../fakeEngine";
import { renderApp } from "../render";
import { mint, TEST_MINT } from "../payments/fixtures";

// covers: payments.cashu.reclaim

/**
 * Ecash sent in a chat that was deleted before the contact took it: the engine keeps it so it can be taken back, but
 * the chat's bubble (Take it back) went with the chat. The Wallet page offers it instead, and Remove wallet too.
 */
function awaitingOn(wallet: WalletView, network: WalletNetwork, awaiting: WalletAwaitingView[]): WalletView {
  return { ...wallet, networks: { ...wallet.networks!, [network]: { ...wallet.networks![network], awaiting } } };
}
const testWallet = (balance: number, awaiting: WalletAwaitingView[]) => awaitingOn(walletView({ mode: "testnet", mints: [mint(TEST_MINT, balance)], balance }), "testnet", awaiting);

describe("ecash sent in a deleted chat, on the Wallet page", () => {
  it("is listed with Take it back; taking it back brings the sats back and the row goes", async () => {
    const { user, engine } = renderApp(<Wallet />);
    engine.update({ wallet: testWallet(87, [{ type: "cashu", kind: "sent", amount: 13, paymentId: "p1", chatGone: true }]) });
    const section = await screen.findByTestId("wallet-sent-ecash");
    expect(within(section).getByRole("heading")).toHaveTextContent("Sent in a deleted chat");
    const [row] = within(section).getAllByTestId("wallet-sent-ecash-item");
    expect(row).toHaveTextContent("13 test sats in ecash you sent, not taken yet");
    expect(row).toHaveTextContent("If your contact never picks it up, the ecash is still yours");
    // The engine takes it back as from the chat's bubble: the sats are in the wallet again, and nothing waits.
    engine.on("reclaimPayment", () => { engine.update({ wallet: testWallet(100, []) }); });
    await user.click(within(row!).getByRole("button", { name: "Take it back" }));
    expect(engine.callsTo("reclaimPayment")).toEqual([{ paymentId: "p1" }]);
    await waitFor(() => expect(screen.queryByTestId("wallet-sent-ecash")).not.toBeInTheDocument());
    expect(screen.getByTestId("wallet-card-cashu-testnet")).toHaveTextContent("100");
  });

  it("keeps the keyboard focus as rows go: on the next row's Take it back, then on the total the sats came back to", async () => {
    const { user, engine } = renderApp(<Wallet />);
    engine.update({ wallet: testWallet(74, [
      { type: "cashu", kind: "sent", amount: 13, paymentId: "p1", chatGone: true },
      { type: "cashu", kind: "sent", amount: 13, paymentId: "p2", chatGone: true },
    ]) });
    engine.on("reclaimPayment", ({ paymentId }) => {
      engine.update({ wallet: paymentId === "p1" ? testWallet(87, [{ type: "cashu", kind: "sent", amount: 13, paymentId: "p2", chatGone: true }]) : testWallet(100, []) });
    });
    const first = (await screen.findAllByTestId("wallet-sent-ecash-take-back"))[0]!;
    first.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getAllByTestId("wallet-sent-ecash-item")).toHaveLength(1));
    // On the next row's Take it back, or on the list while that is still disabled by the run: Tab goes on to it.
    const second = screen.getByTestId("wallet-sent-ecash-take-back");
    await waitFor(() => expect(screen.getByTestId("wallet-sent-ecash").parentElement!.contains(document.activeElement)).toBe(true));
    if (document.activeElement !== second) await user.tab();
    expect(second).toHaveFocus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByTestId("wallet-sent-ecash")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId("wallet-total-bitcoin")).toHaveFocus());
    expect(screen.getByTestId("wallet-total-bitcoin-amount")).toHaveTextContent("100");
  });

  it("is not listed while its chat is there: the chat's bubble offers it back", async () => {
    const { engine } = renderApp(<Wallet />);
    engine.update({ wallet: testWallet(87, [{ type: "cashu", kind: "sent", amount: 13, paymentId: "p1" }]) });
    await screen.findByTestId("wallet-card-cashu-testnet");
    expect(screen.queryByTestId("wallet-sent-ecash")).not.toBeInTheDocument();
  });

  it("says why when it cannot be taken back, and keeps the row", async () => {
    const { user, engine } = renderApp(<Wallet />);
    engine.update({ wallet: testWallet(87, [{ type: "cashu", kind: "sent", amount: 13, paymentId: "p1", chatGone: true }]) });
    engine.on("reclaimPayment", () => { throw new Error("Nothing to reclaim"); });
    await user.click(await screen.findByTestId("wallet-sent-ecash-take-back"));
    expect(await screen.findByTestId("wallet-sent-ecash-error")).toBeInTheDocument();
    expect(screen.getByTestId("wallet-sent-ecash-item")).toBeInTheDocument();
  });

  it("Remove wallet offers Take it back on the ecash it lists as not taken yet", async () => {
    const { user, engine } = renderApp(<Wallet />);
    engine.update({ wallet: testWallet(87, [{ type: "cashu", kind: "sent", amount: 13, paymentId: "p1", chatGone: true }]) });
    await user.click(await screen.findByTestId("wallet-card-cashu-testnet"));
    await user.click(await screen.findByTestId("wallet-remove"));
    const dialog = screen.getByTestId("wallet-remove-dialog");
    expect(within(dialog).getByTestId("wallet-remove-returnable")).toHaveTextContent("Ecash you sent from this wallet has not been taken yet (13 test sats).");
    const [item] = within(dialog).getAllByTestId("wallet-remove-returnable-item");
    expect(item).toHaveTextContent("13 test sats in ecash you sent, not taken yet");
    engine.on("reclaimPayment", () => { engine.update({ wallet: testWallet(100, []) }); });
    await user.click(within(item!).getByRole("button", { name: "Take it back" }));
    expect(engine.callsTo("reclaimPayment")).toEqual([{ paymentId: "p1" }]);
    await waitFor(() => expect(within(dialog).queryByTestId("wallet-remove-returnable")).not.toBeInTheDocument());
    expect(within(dialog).getByTestId("wallet-remove-held")).toHaveTextContent("100 test sats");
  });
});
