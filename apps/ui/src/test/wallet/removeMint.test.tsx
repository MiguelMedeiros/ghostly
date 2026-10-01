import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { MintView } from "@ghostly/browser/shared/types";
import { Wallet } from "../../pages/Wallet";
import { walletView } from "../fakeEngine";
import { renderApp } from "../render";
import { mint, REAL_MINT } from "../payments/fixtures";

// covers: wallet.instances.remove

const OTHER = "https://other.example";

/** The Wallets page on the Mainnet Cashu card, with these mints. */
async function cashuWith(mints: MintView[]) {
  const app = renderApp(<Wallet />);
  app.engine.update({ wallet: walletView({ mints }) });
  app.engine.on("walletRemoveMint", () => {}).on("walletRemove", () => {});
  await app.user.click(await screen.findByTestId("wallet-card-cashu-mainnet"));
  const row = (url: string) => screen.getAllByTestId("mint-row").find((r) => r.textContent?.includes(url.replace(/^https?:\/\//, "")))!;
  return { ...app, row };
}

describe("Remove, on a mint of the Cashu wallet", () => {
  it("asks first, and only Remove there removes it; Cancel removes nothing", async () => {
    const { user, engine, row } = await cashuWith([mint(REAL_MINT, 0), mint(OTHER, 0)]);
    await user.click(within(row(OTHER)).getByTestId("mint-remove"));
    const confirm = screen.getByTestId("mint-remove-confirm");
    expect(confirm).toHaveTextContent(`Remove ${OTHER}?`);
    expect(engine.callsTo("walletRemoveMint")).toEqual([]);
    await user.click(within(confirm).getByTestId("mint-remove-cancel"));
    expect(screen.queryByTestId("mint-remove-confirm")).not.toBeInTheDocument();
    expect(engine.callsTo("walletRemoveMint")).toEqual([]);

    await user.click(within(row(OTHER)).getByTestId("mint-remove"));
    await user.click(within(screen.getByTestId("mint-remove-confirm")).getByTestId("mint-remove-yes"));
    expect(engine.callsTo("walletRemoveMint")).toEqual([{ url: OTHER }]);
    await waitFor(() => expect(screen.queryByTestId("mint-remove-confirm")).not.toBeInTheDocument());
  });

  it("a mint that still waits for money says what, and goes only once the person agrees", async () => {
    const waiting = { ...mint(OTHER, 0), awaiting: [{ type: "cashu" as const, kind: "invoice" as const, amount: 2_500 }] };
    const { user, engine, row } = await cashuWith([mint(REAL_MINT, 0), waiting]);
    await user.click(within(row(OTHER)).getByTestId("mint-remove"));
    const confirm = screen.getByTestId("mint-remove-confirm");
    expect(within(confirm).getByTestId("mint-remove-awaiting")).toHaveTextContent("An invoice for 2,500 sats, not paid yet");
    expect(within(confirm).getByTestId("mint-remove-yes")).toBeDisabled();
    await user.click(within(confirm).getByTestId("mint-remove-understood"));
    await user.click(within(confirm).getByTestId("mint-remove-yes"));
    expect(engine.callsTo("walletRemoveMint")).toEqual([{ url: OTHER, acceptLoss: true }]);
  });

  it("the last mint is the wallet: its Remove opens the wallet's removal, which says it removes the wallet", async () => {
    const { user, engine, row } = await cashuWith([mint(REAL_MINT, 0)]);
    await user.click(within(row(REAL_MINT)).getByTestId("mint-remove"));
    const dialog = screen.getByTestId("wallet-remove-dialog");
    expect(within(dialog).getByTestId("wallet-remove-lead")).toHaveTextContent("This is its last mint: removing it removes the Mainnet Cashu wallet and its Lightning card.");
    expect(screen.queryByTestId("mint-remove-confirm")).not.toBeInTheDocument();
    await user.click(within(dialog).getByTestId("wallet-remove-confirm"));
    expect(engine.callsTo("walletRemoveMint")).toEqual([]);
    expect(engine.callsTo("walletRemove")).toEqual([{ type: "cashu", network: "mainnet" }]);
  });
});
