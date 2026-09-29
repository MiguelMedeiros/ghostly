import { act, fireEvent, screen } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NetworkWalletsView } from "@ghostly/browser/shared/types";
import { CardDeck, WalletDeck, walletCardTestId } from "../../components/WalletDeck";
import { walletCards, type InstanceCard, type WalletCard } from "../../components/walletCardData";
import type { WalletState } from "../../lib/platform";
import { walletView } from "../fakeEngine";
import { renderApp } from "../render";
import { arkReady, everyWallet, mint, REAL_MINT, TEST_MINT } from "./fixtures";

// covers: wallet.deck, payments.chat.cards, wallet.instances.networks

/** A Fedimint federation on regtest, so every kind of wallet has a card. */
const FEDIMINT = { federations: [{ id: "ab".repeat(32), name: "Ghostly regtest", guardians: [], consensusVersion: "2.1", network: "regtest" as const, modules: [], joinedAt: 1, invite: "fed11qq", balance: 0, status: "ready" as const, lightning: true }], balance: 0, history: [] };
/** Every wallet, each on the network of its chain (fakeEngine's walletView). */
const EVERY = walletCards(walletView(everyWallet({ fedimint: FEDIMINT })) as WalletState);
const ORDER = ["cashu:mainnet", "lightning:mainnet", "arkade:testnet", "bark:testnet", "spark:testnet", "bitcoin:mainnet", "fedimint:testnet", "usdt:testnet"];

// The swing a card makes as it comes up (walletDeckMotion.ts) is skipped with reduced motion: only the choice is tested.
beforeEach(() => { document.documentElement.dataset.reduceMotion = "true"; });

/** The wallet page's deck, holding its own choice as the page does. */
function WalletPage({ cards = EVERY, initial = "cashu:mainnet", onSelect }: { cards?: InstanceCard[]; initial?: string; onSelect: (id: string) => void }) {
  const [selected, setSelected] = useState(initial);
  return <WalletDeck cards={cards} selected={selected} onSelect={(id) => { onSelect(id); setSelected(id); }} />;
}

function showWalletDeck(initial?: string, cards?: InstanceCard[]) {
  const onSelect = vi.fn();
  return { ...renderApp(<WalletPage cards={cards} initial={initial} onSelect={onSelect} />), onSelect };
}

const tab = (id: string) => screen.getByTestId(walletCardTestId(id));
/** The small Testnet tag on a card's face, if it wears one. */
const networkTag = (id: string) => tab(id).querySelector("[data-testid='wallet-card-network']");
const chosen = () => screen.getAllByRole("tab").filter((t) => t.getAttribute("aria-selected") === "true").map((t) => t.dataset.testid);

describe("the wallet page's deck", () => {
  it("is a tablist of every wallet, with the chosen one selected and the only one in the tab order", () => {
    showWalletDeck("arkade:testnet");
    const tabs = screen.getAllByRole("tab");
    expect(screen.getByRole("tablist", { name: "Wallet integrations" })).toBeInTheDocument();
    expect(tabs.map((t) => t.dataset.testid)).toEqual(ORDER.map(walletCardTestId));
    expect(chosen()).toEqual(["wallet-card-arkade-testnet"]);
    expect(tabs.map((t) => t.tabIndex)).toEqual([-1, -1, 0, -1, -1, -1, -1, -1]);
    expect(tab("arkade:testnet")).toHaveAttribute("aria-controls", "wallet-panel");
  });

  it.each([
    ["ArrowRight", "cashu:mainnet", "lightning:mainnet"],
    ["ArrowDown", "cashu:mainnet", "lightning:mainnet"],
    ["ArrowLeft", "arkade:testnet", "lightning:mainnet"],
    ["ArrowUp", "arkade:testnet", "lightning:mainnet"],
    ["ArrowRight", "usdt:testnet", "cashu:mainnet"],
    ["ArrowLeft", "cashu:mainnet", "usdt:testnet"],
    ["Home", "bark:testnet", "cashu:mainnet"],
    ["End", "lightning:mainnet", "usdt:testnet"],
  ] as const)("%s from %s moves to %s, and the focus follows", async (key, from, to) => {
    const { user, onSelect } = showWalletDeck(from);
    tab(from).focus();
    await user.keyboard(`{${key}}`);
    expect(onSelect).toHaveBeenCalledWith(to);
    expect(chosen()).toEqual([walletCardTestId(to)]);
    expect(tab(to)).toHaveFocus();
    expect(tab(to).tabIndex).toBe(0);
    expect(tab(from).tabIndex).toBe(-1);
  });

  it("walks the whole deck with the arrow keys", async () => {
    const { user } = showWalletDeck();
    tab("cashu:mainnet").focus();
    for (const rail of [...ORDER.slice(1), "cashu:mainnet"]) {
      await user.keyboard("{ArrowRight}");
      expect(tab(rail)).toHaveFocus();
    }
  });

  it("ignores other keys", async () => {
    const { user, onSelect } = showWalletDeck();
    tab("cashu:mainnet").focus();
    await user.keyboard("a{PageDown}");
    expect(onSelect).not.toHaveBeenCalled();
    expect(chosen()).toEqual(["wallet-card-cashu-mainnet"]);
  });

  it("moves with the Previous and Next arrows, going round at the ends", async () => {
    const { user, onSelect } = showWalletDeck();
    await user.click(screen.getByTestId("wallet-deck-next"));
    expect(chosen()).toEqual(["wallet-card-lightning-mainnet"]);
    await user.click(screen.getByRole("button", { name: "Previous card" }));
    await user.click(screen.getByRole("button", { name: "Previous card" }));
    expect(chosen()).toEqual(["wallet-card-usdt-testnet"]);
    expect(onSelect.mock.calls.map(([rail]) => rail)).toEqual(["lightning:mainnet", "cashu:mainnet", "usdt:testnet"]);
  });

  it("selects the card clicked", async () => {
    const { user, onSelect } = showWalletDeck();
    await user.click(tab("bitcoin:mainnet"));
    expect(onSelect).toHaveBeenCalledWith("bitcoin:mainnet");
    expect(chosen()).toEqual(["wallet-card-bitcoin-mainnet"]);
  });

  it("does not select again the card already chosen", async () => {
    const { user, onSelect } = showWalletDeck("bark:testnet");
    await user.click(tab("bark:testnet"));
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe("the wallet page's deck, a card per wallet and network", () => {
  it("tags each Testnet card, and no Mainnet one", () => {
    showWalletDeck();
    for (const id of ORDER) {
      if (id.endsWith(":testnet")) expect(networkTag(id), id).toHaveTextContent(/^Testnet$/);
      else expect(networkTag(id), id).toBeNull();
    }
  });

  it("shows two wallets of one type, one on each network, as two cards, each with its own balance", async () => {
    const both = walletView({ networks: {
      mainnet: { mints: [mint(REAL_MINT, 1_300)], balance: 1_300, history: [], feesPaid: 0 } as NetworkWalletsView,
      testnet: { mints: [mint(TEST_MINT, 200)], balance: 200, history: [], feesPaid: 0, ark: arkReady() } as NetworkWalletsView,
    } }) as WalletState;
    const { user, onSelect } = showWalletDeck("cashu:mainnet", walletCards(both));
    expect(screen.getAllByRole("tab").map((t) => t.dataset.testid)).toEqual(["wallet-card-cashu-mainnet", "wallet-card-cashu-testnet", "wallet-card-arkade-testnet"]);
    expect(tab("cashu:mainnet")).toHaveTextContent("1,300 sats");
    expect(tab("cashu:mainnet")).not.toHaveTextContent("test sats");
    expect(networkTag("cashu:mainnet")).toBeNull();
    expect(tab("cashu:testnet")).toHaveTextContent("200 test sats");
    expect(networkTag("cashu:testnet")).toHaveTextContent("Testnet");
    // Each is its own tab, named by the wallet's id.
    expect(tab("cashu:mainnet")).toHaveAttribute("id", "wallet-tab-cashu:mainnet");
    expect(tab("cashu:testnet")).toHaveAttribute("id", "wallet-tab-cashu:testnet");
    await user.click(tab("cashu:testnet"));
    expect(onSelect).toHaveBeenCalledWith("cashu:testnet");
    expect(chosen()).toEqual(["wallet-card-cashu-testnet"]);
  });
});

/**
 * A phone's deck, a snapping track, with the layout a browser would give it (happy-dom has none): cards 228 px wide
 * every 240 px in a 300 px track, so card i is centred at scrollLeft 240 × i. `scrollTo` records where the deck sends
 * the track and moves nothing: the test moves it, and says when a scroll ends, in whatever order a browser might.
 */
function showTrack(initial: string) {
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({ matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false }));
  const shown = showWalletDeck(initial);
  const track = screen.getByRole("tablist");
  let left = 240 * ORDER.indexOf(initial);
  const sentTo: number[] = [];
  const box = (x: number, width: number) => ({ left: x, right: x + width, width, top: 0, bottom: 150, height: 150, x, y: 0, toJSON: () => ({}) }) as DOMRect;
  Object.defineProperties(track, { scrollLeft: { get: () => left, configurable: true }, scrollWidth: { value: 2000, configurable: true }, clientWidth: { value: 300, configurable: true } });
  track.getBoundingClientRect = () => box(0, 300);
  track.scrollTo = ((options: ScrollToOptions) => { sentTo.push(options.left!); }) as typeof track.scrollTo;
  ORDER.forEach((rail, i) => {
    const card = tab(rail);
    Object.defineProperties(card, { offsetLeft: { value: 36 + 240 * i, configurable: true }, offsetWidth: { value: 228, configurable: true } });
    card.getBoundingClientRect = () => box(36 + 240 * i - left, 228);
  });
  /** The track comes to rest at card `i`'s place, and the browser says the scroll ended. */
  const scrollEnds = (at: string) => { left = 240 * ORDER.indexOf(at); act(() => { track.dispatchEvent(new Event("scrollend")); }); };
  return { ...shown, track, sentTo, scrollEnds, moveTo: (at: string) => { left = 240 * ORDER.indexOf(at); } };
}

describe("the wallet page's deck on a touch screen", () => {
  it("chooses the card a swipe leaves in the centre", () => {
    const { track, scrollEnds, onSelect } = showTrack("cashu:mainnet");
    expect(track.closest(".wallet-deck")).toHaveAttribute("data-mode", "track");
    fireEvent.pointerDown(track);
    scrollEnds("arkade:testnet");
    expect(onSelect).toHaveBeenCalledWith("arkade:testnet");
    expect(chosen()).toEqual(["wallet-card-arkade-testnet"]);
  });

  it("a second key before the first scroll has ended: the late end of the first does not take the choice back", async () => {
    const { user, sentTo, moveTo, scrollEnds, onSelect } = showTrack("bark:testnet");
    tab("bark:testnet").focus();
    await user.keyboard("{ArrowRight}");
    expect(sentTo).toEqual([960]);
    // The track reaches Spark, and End is pressed before that scroll's end is dispatched.
    moveTo("spark:testnet");
    await user.keyboard("{End}");
    expect(sentTo).toEqual([960, 1680]);
    scrollEnds("spark:testnet");
    expect(chosen()).toEqual(["wallet-card-usdt-testnet"]);
    scrollEnds("usdt:testnet");
    expect(chosen()).toEqual(["wallet-card-usdt-testnet"]);
    expect(onSelect.mock.calls.map(([rail]) => rail)).toEqual(["spark:testnet", "usdt:testnet"]);
  });

  it("a finger takes over a scroll the deck started: where the finger leaves the track decides", async () => {
    const { user, track, scrollEnds } = showTrack("cashu:mainnet");
    await user.click(screen.getByTestId("wallet-deck-next"));
    expect(chosen()).toEqual(["wallet-card-lightning-mainnet"]);
    fireEvent.pointerDown(track);
    scrollEnds("bark:testnet");
    expect(chosen()).toEqual(["wallet-card-bark-testnet"]);
  });

  it("a card already in the centre waits for no scroll: the next swipe chooses at once", async () => {
    const { user, sentTo, scrollEnds } = showTrack("arkade:testnet");
    await user.click(tab("arkade:testnet"));
    expect(sentTo).toEqual([480]);
    scrollEnds("bitcoin:mainnet");
    expect(chosen()).toEqual(["wallet-card-bitcoin-mainnet"]);
  });
});

describe("the chat's deck of ways to pay", () => {
  const cards = EVERY;
  const offHere = (card: WalletCard<string>) => (card.id === "bark:testnet" ? "Bark is off in this chat" : undefined);

  function PayWith({ onSelect, onChoose }: { onSelect: (rail: string) => void; onChoose: (rail: string) => void }) {
    const [selected, setSelected] = useState<string>("cashu:mainnet");
    return <CardDeck<string> compact kind="radios" label="Pay with" name="payment-deck" cards={cards} selected={selected}
      onSelect={(rail) => { onSelect(rail); setSelected(rail); }} onChoose={onChoose} testId={(rail) => `payment-card-${rail}`} blocked={offHere} />;
  }
  function showPayWith() {
    const onSelect = vi.fn(), onChoose = vi.fn();
    return { ...renderApp(<PayWith onSelect={onSelect} onChoose={onChoose} />), onSelect, onChoose };
  }
  const radio = (rail: string) => screen.getByTestId(`payment-card-${rail}`);

  it("is a radiogroup with the chosen card checked", () => {
    showPayWith();
    expect(screen.getByRole("radiogroup", { name: "Pay with" })).toBeInTheDocument();
    expect(screen.getAllByRole("radio")).toHaveLength(8);
    expect(radio("cashu:mainnet")).toHaveAttribute("aria-checked", "true");
    expect(radio("lightning:mainnet")).toHaveAttribute("aria-checked", "false");
  });

  it("chooses the card clicked", async () => {
    const { user, onSelect, onChoose } = showPayWith();
    await user.click(radio("arkade:testnet"));
    expect(onSelect).toHaveBeenCalledWith("arkade:testnet");
    expect(onChoose).toHaveBeenCalledWith("arkade:testnet");
  });

  it("chooses the card already checked when it is clicked again", async () => {
    const { user, onSelect, onChoose } = showPayWith();
    await user.click(radio("cashu:mainnet"));
    expect(onSelect).not.toHaveBeenCalled();
    expect(onChoose).toHaveBeenCalledWith("cashu:mainnet");
  });

  it("brings up a blocked card to say why, but does not choose it", async () => {
    const { user, onSelect, onChoose } = showPayWith();
    expect(radio("bark:testnet")).toHaveAttribute("aria-disabled", "true");
    expect(radio("bark:testnet")).toHaveAttribute("title", "Bark is off in this chat");
    expect(radio("arkade:testnet")).not.toHaveAttribute("aria-disabled");
    await user.click(radio("bark:testnet"));
    expect(onSelect).toHaveBeenCalledWith("bark:testnet");
    expect(radio("bark:testnet")).toHaveAttribute("aria-checked", "true");
    expect(onChoose).not.toHaveBeenCalled();
  });

  it("selects with the arrow keys and chooses with Enter", async () => {
    const { user, onChoose } = showPayWith();
    radio("cashu:mainnet").focus();
    await user.keyboard("{ArrowLeft}");
    expect(radio("usdt:testnet")).toHaveFocus();
    expect(radio("usdt:testnet")).toHaveAttribute("aria-checked", "true");
    expect(onChoose).not.toHaveBeenCalled();
    await user.keyboard("{Enter}");
    expect(onChoose).toHaveBeenCalledWith("usdt:testnet");
  });
});
