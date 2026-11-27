// covers: wallet.history
import { act, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { TEST_MINTS } from "@ghostly/browser/shared/mints";
import { CashuWallet } from "../../components/wallet/CashuWallet";
import { networkState } from "../../components/walletCardData";
import { servicesPlatform, type WalletState } from "../../lib/platform";
import { walletView } from "../fakeEngine";
import { mint } from "../payments/fixtures";
import { renderApp } from "../render";
import * as time from "../../lib/time";

vi.mock("../../lib/time", async (original) => {
  const real = await original<typeof import("../../lib/time")>();
  return { ...real, formatAt: vi.fn(real.formatAt) };
});

describe("the Cashu card's balance counts up without drawing its History again", () => {
  /**
   * Sats that arrive while History is open count the balance up over 700 ms, one frame at a time: only the number is
   * drawn again on each frame, not every movement of the list (100 rows drew 5,300 times for one payment).
   */
  const TEST_MINT = TEST_MINTS[0];
  const history = Array.from({ length: 100 }, (_, i) => ({ id: `tx${i}`, kind: "lightning-in" as const, amount: 10 + i, fee: 0, timestamp: 1_791_000_000_000 + i, mint: TEST_MINT }));
  const at = (balance: number) => networkState(walletView({ mints: [mint(TEST_MINT, balance)], balance, history, mode: "testnet" }) as WalletState, "testnet");

  it("a payment arriving with History open draws its rows once, not on every frame", async () => {
    // The state changes inside the tree: renderApp's rerender would mount it all again.
    let arrive!: (balance: number) => void;
    function Card() {
      const [state, setState] = useState(() => at(1_000));
      arrive = (balance) => setState({ ...state, ...at(balance), history: state.history });
      return <CashuWallet wallet={servicesPlatform!.wallet} state={state} rail="cashu" onOpenCashu={() => {}} />;
    }
    const { user } = renderApp(<Card />);
    await user.click(screen.getByRole("tab", { name: "History" }));
    expect(screen.getAllByTestId("wallet-tx")).toHaveLength(100);
    const formatAt = vi.mocked(time.formatAt);
    formatAt.mockClear();
    act(() => arrive(50_000));
    await waitFor(() => expect(screen.getByTestId("wallet-balance")).toHaveTextContent("50,000"), { timeout: 3_000 });
    // The state's own change draws the rows once; the frames of the count-up draw none of them.
    expect(formatAt.mock.calls.length).toBeLessThanOrEqual(100);
  });
});
