import { Profiler } from "react";
import { act, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Route, Routes } from "react-router-dom";
import { Wallet } from "../../pages/Wallet";
import { fakeEngine, walletView, type StatePatch } from "../fakeEngine";
import { renderApp } from "../render";
import { everyWallet, mint, REAL_MINT } from "../payments/fixtures";

// covers: wallet.deck

/**
 * The engine sends its whole state anew on every change, up to 20 times a second while a file moves. The Wallets page
 * (its deck and the open wallet's panel) draws again only when the wallets change, not on every state.
 */

function openWallet() {
  fakeEngine.setState({ wallet: walletView(everyWallet()) });
  let commits = 0;
  renderApp(
    <Profiler id="wallet" onRender={() => { commits++; }}>
      <Routes><Route path="/wallet" element={<Wallet />} /></Routes>
    </Profiler>,
    { route: "/wallet" },
  );
  return { commits: () => commits };
}

/** The state as the engine sends it after a change elsewhere: the same content, every object new. */
const sentAgain = (patch: StatePatch = {}) => act(() => fakeEngine.setState({ ...structuredClone(fakeEngine.state), ...patch } as StatePatch));

describe("the Wallets page on an engine state", () => {
  it("is not drawn again when the wallets did not change", async () => {
    const { commits } = openWallet();
    expect(await screen.findByTestId("wallet-panel")).toBeInTheDocument();
    const before = commits();
    for (let i = 0; i < 5; i++) sentAgain({ transfers: { [`file-${i}`]: { state: "transferring", transferred: i * 1000, size: 10_000 } } });
    expect(commits() - before).toBe(0);
  });

  it("is drawn again when a wallet changes", async () => {
    const { commits } = openWallet();
    expect(await screen.findByTestId("wallet-panel")).toHaveTextContent("1,000");
    const before = commits();
    sentAgain({ wallet: walletView(everyWallet({ mints: [mint(REAL_MINT, 2_500)], balance: 2_500 })) });
    expect(await screen.findByTestId("wallet-panel")).toHaveTextContent("2,500");
    expect(commits() - before).toBeGreaterThanOrEqual(1);
  });
});
