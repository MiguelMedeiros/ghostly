import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TEST_MINTS } from "@ghostly/browser/shared/mints";
import { CashuWallet } from "../../components/wallet/CashuWallet";
import { networkState } from "../../components/walletCardData";
import { servicesPlatform, type WalletPlatform, type WalletState } from "../../lib/platform";
import { walletView } from "../fakeEngine";
import { mint } from "../payments/fixtures";
import { renderApp } from "../render";

// covers: wallet.cashu.mint.add

/**
 * On a phone the Cashu card is one long column: what Add (a mint) and Copy backup answer is shown by the button that
 * was pressed, not above the Mints section, where it is drawn off the screen (a phone's keyboard up, or the page
 * scrolled down to Settings). The copied backup's line is said aloud too.
 */
describe("the Cashu card answers Add and Copy backup where they were pressed", () => {
  const show = (methods: Partial<WalletPlatform>) => {
    const state = networkState(walletView({ mode: "testnet", mints: [mint(TEST_MINTS[0], 5_000)], balance: 5_000 }) as WalletState, "testnet");
    const wallet: WalletPlatform = Object.assign(Object.create(servicesPlatform!.wallet), methods);
    return renderApp(<CashuWallet wallet={wallet} state={state} rail="cashu" onOpenCashu={() => {}} />);
  };

  it("a refused mint is said in the Mints section, by its field", async () => {
    const { user } = show({ addMint: async () => { throw new Error("Mints must use https"); } });
    await user.type(screen.getByTestId("wallet-mint-url"), "http://mint.example{Enter}");
    const error = await screen.findByTestId("wallet-error");
    expect(error).toHaveTextContent("Mints must use https");
    expect(within(screen.getByTestId("wallet-mints")).getByTestId("wallet-error")).toBe(error);
  });

  it("a copied backup is said below Copy backup, in a live region", async () => {
    const { user } = show({ exportTokens: async () => [{ token: "cashuBtoken", mint: TEST_MINTS[0], amount: 5_000 }] as never });
    await user.click(screen.getByRole("button", { name: "Copy backup" }));
    const notice = await screen.findByTestId("wallet-notice");
    expect(notice).toHaveTextContent("Backup copied.");
    expect(within(screen.getByTestId("wallet-backup")).getByTestId("wallet-notice")).toBe(notice);
    expect(within(screen.getByTestId("wallet-backup")).getByRole("status")).toHaveTextContent("Backup copied.");
  });
});
