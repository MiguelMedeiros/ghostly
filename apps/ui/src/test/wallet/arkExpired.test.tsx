import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ArkWalletPanel } from "../../components/ArkWalletPanel";
import { networkState } from "../../components/walletCardData";
import { servicesPlatform, type WalletState } from "../../lib/platform";
import { walletView } from "../fakeEngine";
import { arkReady } from "../payments/fixtures";
import { renderApp } from "../render";
// covers: wallet.ark.recover

/**
 * Ark coins whose batch expired before they were renewed: until the server sweeps that batch they can be neither
 * spent nor recovered, so the panel says they wait and offers no Recover; once swept, Recover.
 */
describe("the Ark panel's expired coins", () => {
  const wallet = servicesPlatform!.wallet;
  const panel = (ark: Parameters<typeof arkReady>[0]) =>
    renderApp(<ArkWalletPanel wallet={wallet} state={networkState(walletView({ ark: arkReady({ network: "regtest", ...ark }) }) as WalletState, "testnet")} />);

  it("waiting for the sweep: says so, with the why behind the info button, and no Recover", async () => {
    panel({ balance: 0, sweeping: 9_900 });
    const waiting = screen.getByTestId("ark-sweeping");
    expect(waiting).toHaveTextContent(/^9,900 test sats expired\. You can recover them once the Ark server has swept their batch\.$/);
    expect(screen.queryByTestId("ark-recover")).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId("row-info"));
    expect(screen.getByTestId("row-info-text")).toHaveTextContent("a sweep");
  });

  it("swept: Recover", () => {
    panel({ balance: 0, recoverable: 9_900 });
    expect(screen.getByTestId("ark-recoverable")).toHaveTextContent("9,900 test sats expired before they were renewed");
    expect(screen.getByTestId("ark-recover")).toBeEnabled();
    expect(screen.queryByTestId("ark-sweeping")).not.toBeInTheDocument();
  });

  it("swept but too few for a recovery of their own: said so, no Recover", () => {
    panel({ balance: 9_300, small: 250 });
    expect(screen.getByTestId("ark-small")).toHaveTextContent(/^250 test sats expired, too few to recover on their own\./);
    expect(screen.queryByTestId("ark-recover")).not.toBeInTheDocument();
  });
});
