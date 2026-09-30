import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BarkWalletPanel } from "../../components/BarkWalletPanel";
import { networkState } from "../../components/walletCardData";
import { servicesPlatform, type WalletNetwork, type WalletState } from "../../lib/platform";
import { walletView } from "../fakeEngine";
import { barkReady } from "../payments/fixtures";
import { renderApp } from "../render";

// covers: wallet.bark.mainnet, wallet.bark.create

const onNetwork = (network: WalletNetwork, patch: Partial<WalletState>) => networkState(walletView(patch) as WalletState, network);
const MAINNET = { network: "bitcoin" as const, provider: "https://ark.second.tech", address: "ark1pbark", terms: "https://second.tech/terms" };

describe("the Bark panel", () => {
  it("on Mainnet: Bitcoin only (no test network switch), Second's terms, and what the coins ask of their owner", async () => {
    const state = onNetwork("mainnet", { bark: barkReady({ ...MAINNET, balance: 0, expiry: { blocksLeft: 300, lifetime: 4032 } }) });
    const { user, engine } = renderApp(<BarkWalletPanel wallet={servicesPlatform!.wallet.forNetwork("mainnet")} state={state} />);
    expect(screen.getByTestId("bark-balance")).toHaveTextContent(/^0\s*sats/);
    expect(screen.getByTestId("bark-network")).toHaveTextContent("Bitcoin");
    expect(screen.queryByRole("radiogroup", { name: "Bark network" })).not.toBeInTheDocument();
    expect(screen.getByTestId("bark-terms")).toHaveAttribute("href", "https://second.tech/terms");
    const essentials = screen.getByTestId("bark-essentials");
    expect(within(essentials).getByTestId("bark-expiry")).toHaveTextContent("Coins last about 28 days on this server. Ghostly renews them close to expiry while it is open, so open it before then. The next one expires in about 2 days.");
    expect(within(essentials).getByTestId("bark-expiry")).toHaveClass("text-yellow-500");
    expect(within(essentials).getByTestId("bark-exit")).toHaveTextContent("If the server disappears, coins can still be taken back on-chain before they expire (a unilateral exit, paying on-chain fees), but Ghostly has no button for that yet, so keep amounts small.");
    // Another server, while empty, stays on Bitcoin.
    engine.on("barkCreate", () => undefined);
    await user.click(screen.getByRole("button", { name: "Change" }));
    await user.click(screen.getByRole("button", { name: "Use this server" }));
    expect(engine.callsTo("barkCreate")).toEqual([{ network: "bitcoin", provider: "https://ark.second.tech", explorer: "https://mempool.second.tech/api" }]);
  });

  it("with no coin yet, says how long coins last and nothing about a next expiry", () => {
    const state = onNetwork("mainnet", { bark: barkReady({ ...MAINNET, expiry: { lifetime: 4032 } }) });
    renderApp(<BarkWalletPanel wallet={{} as never} state={state} />);
    expect(screen.getByTestId("bark-expiry")).toHaveTextContent(/^Coins last about 28 days on this server\. Ghostly renews them close to expiry while it is open, so open it before then\.$/);
    expect(screen.getByTestId("bark-expiry")).not.toHaveClass("text-yellow-500");
  });

  it("on Testnet: the test networks only, no terms, and the exit line without the real-money advice", () => {
    const state = onNetwork("testnet", { bark: barkReady({ network: "signet", balance: 0, expiry: { blocksLeft: 100, lifetime: 144 } }) });
    renderApp(<BarkWalletPanel wallet={{} as never} state={state} />);
    const networks = screen.getByRole("radiogroup", { name: "Bark network" });
    expect(within(networks).getAllByRole("radio").map((r) => r.textContent)).toEqual(["Signet", "Regtest"]);
    expect(screen.queryByTestId("bark-terms")).not.toBeInTheDocument();
    expect(screen.getByTestId("bark-expiry")).toHaveTextContent("Coins last about 1 day on this server.");
    expect(screen.getByTestId("bark-expiry")).toHaveTextContent("The next one expires in less than a day.");
    expect(screen.getByTestId("bark-exit")).not.toHaveTextContent("keep amounts small");
  });
});
