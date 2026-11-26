import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TEST_MINTS } from "@ghostly/browser/shared/mints";
import { CashuWallet } from "../../components/wallet/CashuWallet";
import { networkState } from "../../components/walletCardData";
import { servicesPlatform, type WalletNetwork, type WalletPlatform, type WalletState } from "../../lib/platform";
import { walletView } from "../fakeEngine";
import { mint } from "../payments/fixtures";
import { renderApp } from "../render";

// covers: wallet.cashu.receive-token
describe("a token redeemed on the other network's Cashu card is said in its own money", () => {
  /**
   * Send on a Cashu card redeems any token of a mint the profile knows, and the sats land at the token's mint, so in that
   * mint's network's wallet: a test mint's token pasted on the Mainnet card goes to the Testnet wallet, a real mint's on
   * the Testnet card to the Mainnet one. The line said "Redeemed 39 sats" on a real-money card for test sats, and
   * "Redeemed 29 test sats" for real ones: the card's unit, not the token's.
   */
  const TEST_MINT = TEST_MINTS[0];
  const REAL_MINT = "https://mint.minibits.cash/Bitcoin";
  // Any text Send reads as a token: what it names is what `inspectCashu` answers below.
  const TOKEN = "cashuBo2FteBtodHRwczovL3Rlc3RudXQuY2FzaHUuc3BhY2VhdWNzYXRhdIGiYWlIAJofKTJT5B5hcIGkYWEBYXN4QDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMGFjWCECAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

  const show = (card: WalletNetwork, tokenMint: string | null, fee = 0) => {
    const own = card === "testnet" ? TEST_MINT : REAL_MINT;
    const state = networkState(walletView({ mode: card, mints: [mint(own, 5_000)], balance: 5_000 }) as WalletState, card);
    const methods: Partial<WalletPlatform> = {
      receiveToken: async () => ({ amount: 8, fee }),
      inspectCashu: async () => (tokenMint ? { kind: "token", mint: tokenMint, amount: 8 + fee, unit: "sat", accepted: true } : null),
    };
    const wallet: WalletPlatform = Object.assign(Object.create(servicesPlatform!.wallet), methods);
    return renderApp(<CashuWallet wallet={wallet} state={state} rail="cashu" onOpenCashu={() => {}} />, { language: "en" });
  };
  const redeem = async (user: ReturnType<typeof show>["user"]) => {
    await user.click(screen.getByTestId("wallet-send"));
    await user.click(screen.getByTestId("wallet-pay-input"));
    await user.paste(TOKEN);
    await user.click(screen.getAllByRole("button").find((button) => button.getAttribute("type") === "submit")!);
    return (await screen.findByTestId("wallet-notice")).textContent;
  };

  it("a test mint's token on the Mainnet card: test sats, not sats", async () => {
    const { user } = show("mainnet", TEST_MINT);
    expect(await redeem(user)).toBe("Redeemed 8 test sats.");
  });

  it("a real mint's token on the Testnet card: sats, not test sats, with the fee too", async () => {
    const { user } = show("testnet", REAL_MINT, 1);
    expect(await redeem(user)).toBe("Redeemed 8 sats (the mint kept 1 as its fee).");
  });

  it("a token of the card's own network, or one the wallet cannot read, keeps the card's unit", async () => {
    const own = show("testnet", TEST_MINT);
    expect(await redeem(own.user)).toBe("Redeemed 8 test sats.");
    own.unmount();
    const unread = show("mainnet", null);
    expect(await redeem(unread.user)).toBe("Redeemed 8 sats.");
  });
});
