import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { WalletInstanceView, WalletOffer, WalletView } from "@ghostly/browser/shared/types";
import { Wallet } from "../../pages/Wallet";
import { walletView } from "../fakeEngine";
import { renderApp } from "../render";
import { arkReady, mint, REAL_MINT, TEST_MINT, usdtReady } from "../payments/fixtures";
import { offered } from "./descriptors";
import { choose } from "../select";

// covers: wallet.instances.create, wallet.instances.networks, wallet.deck

const made = (type: WalletInstanceView["type"], network: WalletInstanceView["network"]): WalletInstanceView => ({ id: `${type}:${network}`, type, network, config: {} });
/** What New offers when nothing is made yet: every kind, Bark, Spark and Fedimint Testnet only. */
const offers = (patch: Partial<Record<string, Partial<WalletOffer>>> = {}): WalletOffer[] =>
  (["cashu", "lightning", "arkade", "bark", "spark", "bitcoin", "fedimint", "usdt"] as const).flatMap((type) => (["mainnet", "testnet"] as const).map((network) => {
    const base: WalletOffer = (type === "bark" || type === "spark" || type === "fedimint") && network === "mainnet"
      ? { type, network, available: false, reason: `${type} on Mainnet is not available yet: it has only been tried on test networks.` }
      : type === "fedimint" ? { type, network, available: true, needs: "invite" }
      : type === "lightning" ? { type, network, available: true, needs: "provider", providers: offered("lightning", network).filter((d) => d.id !== "cashu-mint") }
      : type === "bitcoin" ? (network === "testnet" ? { type, network, available: true, needs: "provider", providers: offered("onchain", network) } : { type, network, available: false, reason: "No on-chain wallet runs on Mainnet here yet" })
      : { type, network, available: true };
    return { ...base, ...patch[`${type}:${network}`] };
  }));
const empty = (): WalletView => walletView({ offers: offers() });

describe("a profile with no wallet yet", () => {
  it("is not a dead end: it says how to start, with New in the header and no network switch", async () => {
    const { engine } = renderApp(<Wallet />);
    engine.update({ wallet: empty() });
    expect(await screen.findByTestId("wallet-first")).toHaveTextContent("Create your first wallet");
    expect(screen.getByTestId("wallet-add")).toHaveTextContent("New");
    expect(screen.queryByTestId("wallet-mode")).not.toBeInTheDocument();
    expect(screen.queryByTestId("testnet-notice")).not.toBeInTheDocument();
    expect(screen.queryByRole("tablist", { name: "Wallet integrations" })).not.toBeInTheDocument();
  });

  it("makes Cashu and USDT on the network chosen, one after the other, and then shows their cards", async () => {
    const { user, engine } = renderApp(<Wallet />);
    engine.update({ wallet: empty() });
    engine.on("walletCreate", (params) => {
      const wallets = [...(engine.state.wallet.wallets ?? []), made(params.type, params.network)];
      engine.update({ wallet: walletView({ mints: [mint(TEST_MINT, 0)], usdt: wallets.some((w) => w.type === "usdt") ? usdtReady({ balance: "0" }) : undefined, offers: offers() }) });
      return made(params.type, params.network);
    });
    await user.click(await screen.findByTestId("wallet-first-testnet"));
    expect(engine.callsTo("walletCreate")).toEqual([{ type: "cashu", network: "testnet" }, { type: "usdt", network: "testnet" }]);
    const deck = await screen.findByRole("tablist", { name: "Wallet integrations" });
    expect(within(deck).getByTestId("wallet-card-cashu-testnet")).toHaveTextContent("Testnet");
    expect(within(deck).getByTestId("wallet-card-usdt-testnet")).toBeInTheDocument();
    expect(screen.queryByTestId("wallet-first")).not.toBeInTheDocument();
  });

  it("says which one failed, keeps what was made, and tries only that one again", async () => {
    const { user, engine } = renderApp(<Wallet />);
    engine.update({ wallet: empty() });
    let usdtDown = true;
    engine.on("walletCreate", (params) => {
      if (params.type === "usdt" && usdtDown) throw new Error("Could not create the Mainnet USDT wallet: RPC unavailable. Nothing was saved; try again.");
      return made(params.type, params.network);
    });
    await user.click(await screen.findByTestId("wallet-first-mainnet"));
    expect(await screen.findByTestId("wallet-first-error-usdt")).toHaveTextContent("RPC unavailable. Nothing was saved; try again.");
    expect(screen.queryByTestId("wallet-first-error-cashu")).not.toBeInTheDocument();
    usdtDown = false;
    await user.click(screen.getByTestId("wallet-first-retry-usdt"));
    expect(engine.callsTo("walletCreate").slice(-1)).toEqual([{ type: "usdt", network: "mainnet" }]);
    expect(screen.queryByTestId("wallet-first-error-usdt")).not.toBeInTheDocument();
  });
});

describe("New, in the header", () => {
  it("offers every kind on the network chosen, says what each needs, and why one is not there yet", async () => {
    const { user, engine } = renderApp(<Wallet />);
    engine.update({ wallet: walletView({ mints: [mint(TEST_MINT, 5)], balance: 5, offers: offers({ "cashu:testnet": { exists: true } }) }) });
    await user.click(await screen.findByTestId("wallet-add"));
    const dialog = screen.getByTestId("new-wallet");
    expect(within(dialog).getByTestId("new-wallet-network")).toHaveAttribute("data-network", "testnet");
    expect(within(dialog).getByTestId("new-wallet-type-cashu-status")).toHaveTextContent("Added");
    expect(within(dialog).getByTestId("new-wallet-type-arkade-status")).toHaveTextContent("One click");
    expect(within(dialog).getByTestId("new-wallet-type-fedimint-status")).toHaveTextContent("Needs an invite");
    expect(within(dialog).getByTestId("new-wallet-type-lightning-status")).toHaveTextContent("Choose a source");
    await user.click(within(dialog).getByRole("radio", { name: "Mainnet" }));
    expect(within(dialog).getByTestId("new-wallet-network")).toHaveAttribute("data-network", "mainnet");
    expect(within(dialog).getByTestId("new-wallet-type-bark")).toHaveAttribute("aria-disabled", "true");
    expect(within(dialog).getByTestId("new-wallet-type-bark")).toHaveTextContent("bark on Mainnet is not available yet");
    expect(within(dialog).getByTestId("new-wallet-type-bark-status")).toHaveTextContent("Not yet");
    expect(within(dialog).getByTestId("new-wallet-type-cashu-status")).toHaveTextContent("One click");
    // A kind that is not there yet makes nothing when clicked.
    engine.on("walletCreate", () => made("bark", "mainnet"));
    await user.click(within(dialog).getByTestId("new-wallet-type-bark"));
    expect(engine.callsTo("walletCreate")).toEqual([]);
  });

  it("makes a kind that needs nothing in one click, and brings its card up", async () => {
    const { user, engine } = renderApp(<Wallet />);
    engine.update({ wallet: walletView({ mints: [mint(REAL_MINT, 10)], balance: 10, offers: offers() }) });
    engine.on("walletCreate", (params) => {
      engine.update({ wallet: walletView({ mints: [mint(REAL_MINT, 10)], balance: 10, ark: arkReady(), offers: offers() }) });
      return made(params.type, params.network);
    });
    await user.click(await screen.findByTestId("wallet-add"));
    // It opens on the chosen card's network (Mainnet Cashu here): the network is one click away.
    expect(screen.getByTestId("new-wallet-network")).toHaveAttribute("data-network", "mainnet");
    await user.click(screen.getByRole("radio", { name: "Testnet" }));
    await user.click(screen.getByTestId("new-wallet-type-arkade"));
    expect(engine.callsTo("walletCreate")).toEqual([{ type: "arkade", network: "testnet" }]);
    expect(screen.queryByTestId("new-wallet")).not.toBeInTheDocument();
    expect(await screen.findByTestId("wallet-card-arkade-testnet")).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByTestId("ark-wallet", {}, { timeout: 5000 })).toBeInTheDocument();
  });

  it("a creation that fails says why once, leaves the dialog open, and tries again on request", async () => {
    const { user, engine } = renderApp(<Wallet />);
    engine.update({ wallet: walletView({ mints: [mint(REAL_MINT, 10)], balance: 10, offers: offers() }) });
    let down = true;
    engine.on("walletCreate", (params) => {
      if (down) throw new Error("Could not create the Testnet Ark wallet: It did not answer in time. Nothing was saved; try again.");
      return made(params.type, params.network);
    });
    await user.click(await screen.findByTestId("wallet-add"));
    await user.click(screen.getByRole("radio", { name: "Testnet" }));
    await user.click(screen.getByTestId("new-wallet-type-arkade"));
    expect(await screen.findByTestId("new-wallet-error")).toHaveTextContent("It did not answer in time. Nothing was saved; try again.");
    down = false;
    await user.click(screen.getByTestId("new-wallet-retry"));
    expect(engine.callsTo("walletCreate")).toHaveLength(2);
    expect(screen.queryByTestId("new-wallet")).not.toBeInTheDocument();
  });

  it("Fedimint asks for its invite only, and Lightning for its source's form only", async () => {
    const { user, engine } = renderApp(<Wallet />);
    engine.update({ wallet: walletView({ mints: [mint(REAL_MINT, 10)], balance: 10, offers: offers() }) });
    engine.on("walletCreate", (params) => made(params.type, params.network));
    await user.click(await screen.findByTestId("wallet-add"));
    await user.click(screen.getByRole("radio", { name: "Testnet" }));
    await user.click(screen.getByTestId("new-wallet-type-fedimint"));
    expect(engine.callsTo("walletCreate")).toEqual([]);
    await user.type(screen.getByTestId("new-wallet-invite"), "fed11qqqq");
    await user.click(screen.getByTestId("new-wallet-create"));
    expect(engine.callsTo("walletCreate")).toEqual([{ type: "fedimint", network: "testnet", invite: "fed11qqqq" }]);

    await user.click(await screen.findByTestId("wallet-add"));
    await user.click(screen.getByRole("radio", { name: "Testnet" }));
    await user.click(screen.getByTestId("new-wallet-type-lightning"));
    const form = await screen.findByTestId("new-wallet-provider");
    await choose(user, within(form).getByRole("combobox", { name: "Source" }), "nwc");
    expect(await within(form).findByTestId("provider-form-nwc")).toBeInTheDocument();
    expect(engine.callsTo("walletCreate")).toHaveLength(1);
  });
});

describe("the deck, one card per wallet", () => {
  it("shows a wallet on each network as its own card, and only the test one says Testnet", async () => {
    const { engine } = renderApp(<Wallet />);
    engine.update({ wallet: walletView({ mints: [mint(REAL_MINT, 21), mint(TEST_MINT, 5)], balance: 26, offers: offers() }) });
    const deck = await screen.findByRole("tablist", { name: "Wallet integrations" });
    const mainnet = within(deck).getByTestId("wallet-card-cashu-mainnet"), testnet = within(deck).getByTestId("wallet-card-cashu-testnet");
    expect(within(testnet).getByTestId("wallet-card-network")).toHaveTextContent("Testnet");
    expect(within(mainnet).queryByTestId("wallet-card-network")).not.toBeInTheDocument();
    expect(testnet).toHaveTextContent("test sats");
    expect(mainnet).not.toHaveTextContent("test sats");
  });

  it("a card's panel acts on its own network's wallet", async () => {
    const { user, engine } = renderApp(<Wallet />);
    engine.update({ wallet: walletView({ mints: [mint(REAL_MINT, 21), mint(TEST_MINT, 5)], balance: 26, offers: offers() }) });
    engine.on("walletReceiveLightning", () => ({ quote: "q", invoice: "lnbc210n1test", expiresAt: null, source: "cashu-mint" }));
    await user.click(await screen.findByTestId("wallet-card-cashu-testnet"));
    await user.click(await screen.findByTestId("wallet-receive"));
    await user.type(screen.getByTestId("wallet-receive-amount"), "21");
    await user.click(screen.getByTestId("wallet-create-invoice"));
    expect(engine.callsTo("walletReceiveLightning")).toEqual([{ amount: 21, via: "cashu", network: "testnet" }]);
  });
});
