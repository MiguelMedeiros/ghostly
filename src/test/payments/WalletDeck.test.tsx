import { act, fireEvent, screen } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_MINTS } from "@ghostly/browser/shared/mints";
import { CardDeck, WalletDeck } from "../../components/WalletDeck";
import { walletCards, type WalletCard, type WalletRail } from "../../components/walletCardData";
import { walletView } from "../fakeEngine";
import { renderApp } from "../render";
import { arkReady, everyWallet } from "./fixtures";

// covers: wallet.deck, payments.chat.cards

const ORDER: WalletRail[] = ["cashu", "lightning", "arkade", "bark", "bitcoin", "fedimint", "usdt"];

// The swing a card makes as it comes up (walletDeckMotion.ts) is skipped with reduced motion: only the choice is tested.
beforeEach(() => { document.documentElement.dataset.reduceMotion = "true"; });

/** The wallet page's deck, holding its own choice as the page does. */
function WalletPage({ initial = "cashu", onSelect }: { initial?: WalletRail; onSelect: (rail: WalletRail) => void }) {
  const [selected, setSelected] = useState<WalletRail>(initial);
  return <WalletDeck state={walletView(everyWallet())} selected={selected} onSelect={(rail) => { onSelect(rail); setSelected(rail); }} testMints={TEST_MINTS} />;
}

function showWalletDeck(initial?: WalletRail) {
  const onSelect = vi.fn();
  return { ...renderApp(<WalletPage initial={initial} onSelect={onSelect} />), onSelect };
}

const tab = (rail: WalletRail) => screen.getByTestId(`wallet-card-${rail}`);
const chosen = () => screen.getAllByRole("tab").filter((t) => t.getAttribute("aria-selected") === "true").map((t) => t.dataset.testid);

describe("the wallet page's deck", () => {
  it("is a tablist of every wallet, with the chosen one selected and the only one in the tab order", () => {
    showWalletDeck("arkade");
    const tabs = screen.getAllByRole("tab");
    expect(screen.getByRole("tablist", { name: "Wallet integrations" })).toBeInTheDocument();
    expect(tabs.map((t) => t.dataset.testid)).toEqual(ORDER.map((rail) => `wallet-card-${rail}`));
    expect(chosen()).toEqual(["wallet-card-arkade"]);
    expect(tabs.map((t) => t.tabIndex)).toEqual([-1, -1, 0, -1, -1, -1]);
    expect(tab("arkade")).toHaveAttribute("aria-controls", "wallet-panel");
  });

  it.each([
    ["ArrowRight", "cashu", "lightning"],
    ["ArrowDown", "cashu", "lightning"],
    ["ArrowLeft", "arkade", "lightning"],
    ["ArrowUp", "arkade", "lightning"],
    ["ArrowRight", "usdt", "cashu"],
    ["ArrowLeft", "cashu", "usdt"],
    ["Home", "bark", "cashu"],
    ["End", "lightning", "usdt"],
  ] as const)("%s from %s moves to %s, and the focus follows", async (key, from, to) => {
    const { user, onSelect } = showWalletDeck(from);
    tab(from).focus();
    await user.keyboard(`{${key}}`);
    expect(onSelect).toHaveBeenCalledWith(to);
    expect(chosen()).toEqual([`wallet-card-${to}`]);
    expect(tab(to)).toHaveFocus();
    expect(tab(to).tabIndex).toBe(0);
    expect(tab(from).tabIndex).toBe(-1);
  });

  it("walks the whole deck with the arrow keys", async () => {
    const { user } = showWalletDeck();
    tab("cashu").focus();
    for (const rail of [...ORDER.slice(1), "cashu" as const]) {
      await user.keyboard("{ArrowRight}");
      expect(tab(rail)).toHaveFocus();
    }
  });

  it("ignores other keys", async () => {
    const { user, onSelect } = showWalletDeck();
    tab("cashu").focus();
    await user.keyboard("a{PageDown}");
    expect(onSelect).not.toHaveBeenCalled();
    expect(chosen()).toEqual(["wallet-card-cashu"]);
  });

  it("moves with the Previous and Next arrows, going round at the ends", async () => {
    const { user, onSelect } = showWalletDeck();
    await user.click(screen.getByTestId("wallet-deck-next"));
    expect(chosen()).toEqual(["wallet-card-lightning"]);
    await user.click(screen.getByRole("button", { name: "Previous card" }));
    await user.click(screen.getByRole("button", { name: "Previous card" }));
    expect(chosen()).toEqual(["wallet-card-usdt"]);
    expect(onSelect.mock.calls.map(([rail]) => rail)).toEqual(["lightning", "cashu", "usdt"]);
  });

  it("selects the card clicked", async () => {
    const { user, onSelect } = showWalletDeck();
    await user.click(tab("bitcoin"));
    expect(onSelect).toHaveBeenCalledWith("bitcoin");
    expect(chosen()).toEqual(["wallet-card-bitcoin"]);
  });

  it("does not select again the card already chosen", async () => {
    const { user, onSelect } = showWalletDeck("bark");
    await user.click(tab("bark"));
    expect(onSelect).not.toHaveBeenCalled();
  });
});

/**
 * A phone's deck, a snapping track, with the layout a browser would give it (happy-dom has none): cards 228 px wide
 * every 240 px in a 300 px track, so card i is centred at scrollLeft 240 × i. `scrollTo` records where the deck sends
 * the track and moves nothing: the test moves it, and says when a scroll ends, in whatever order a browser might.
 */
function showTrack(initial: WalletRail) {
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
  const scrollEnds = (at: WalletRail) => { left = 240 * ORDER.indexOf(at); act(() => { track.dispatchEvent(new Event("scrollend")); }); };
  return { ...shown, track, sentTo, scrollEnds, moveTo: (at: WalletRail) => { left = 240 * ORDER.indexOf(at); } };
}

describe("the wallet page's deck on a touch screen", () => {
  it("chooses the card a swipe leaves in the centre", () => {
    const { track, scrollEnds, onSelect } = showTrack("cashu");
    expect(track.closest(".wallet-deck")).toHaveAttribute("data-mode", "track");
    fireEvent.pointerDown(track);
    scrollEnds("arkade");
    expect(onSelect).toHaveBeenCalledWith("arkade");
    expect(chosen()).toEqual(["wallet-card-arkade"]);
  });

  it("a second key before the first scroll has ended: the late end of the first does not take the choice back", async () => {
    const { user, sentTo, moveTo, scrollEnds, onSelect } = showTrack("bark");
    tab("bark").focus();
    await user.keyboard("{ArrowRight}");
    expect(sentTo).toEqual([960]);
    // The track reaches Bitcoin, and End is pressed before that scroll's end is dispatched.
    moveTo("bitcoin");
    await user.keyboard("{End}");
    expect(sentTo).toEqual([960, 1200]);
    scrollEnds("bitcoin");
    expect(chosen()).toEqual(["wallet-card-usdt"]);
    scrollEnds("usdt");
    expect(chosen()).toEqual(["wallet-card-usdt"]);
    expect(onSelect.mock.calls.map(([rail]) => rail)).toEqual(["bitcoin", "usdt"]);
  });

  it("a finger takes over a scroll the deck started: where the finger leaves the track decides", async () => {
    const { user, track, scrollEnds } = showTrack("cashu");
    await user.click(screen.getByTestId("wallet-deck-next"));
    expect(chosen()).toEqual(["wallet-card-lightning"]);
    fireEvent.pointerDown(track);
    scrollEnds("bark");
    expect(chosen()).toEqual(["wallet-card-bark"]);
  });

  it("a card already in the centre waits for no scroll: the next swipe chooses at once", async () => {
    const { user, sentTo, scrollEnds } = showTrack("arkade");
    await user.click(tab("arkade"));
    expect(sentTo).toEqual([480]);
    scrollEnds("bitcoin");
    expect(chosen()).toEqual(["wallet-card-bitcoin"]);
  });
});

describe("the chat's deck of ways to pay", () => {
  const cards = walletCards(walletView(everyWallet({ ark: arkReady() })), TEST_MINTS);
  const offHere = (card: WalletCard) => (card.id === "bark" ? "Bark is off in this chat" : undefined);

  function PayWith({ onSelect, onChoose }: { onSelect: (rail: WalletRail) => void; onChoose: (rail: WalletRail) => void }) {
    const [selected, setSelected] = useState<WalletRail>("cashu");
    return <CardDeck compact kind="radios" label="Pay with" name="payment-deck" cards={cards} selected={selected}
      onSelect={(rail) => { onSelect(rail); setSelected(rail); }} onChoose={onChoose} testId={(rail) => `payment-card-${rail}`} blocked={offHere} />;
  }
  function showPayWith() {
    const onSelect = vi.fn(), onChoose = vi.fn();
    return { ...renderApp(<PayWith onSelect={onSelect} onChoose={onChoose} />), onSelect, onChoose };
  }
  const radio = (rail: WalletRail) => screen.getByTestId(`payment-card-${rail}`);

  it("is a radiogroup with the chosen card checked", () => {
    showPayWith();
    expect(screen.getByRole("radiogroup", { name: "Pay with" })).toBeInTheDocument();
    expect(screen.getAllByRole("radio")).toHaveLength(6);
    expect(radio("cashu")).toHaveAttribute("aria-checked", "true");
    expect(radio("lightning")).toHaveAttribute("aria-checked", "false");
  });

  it("chooses the card clicked", async () => {
    const { user, onSelect, onChoose } = showPayWith();
    await user.click(radio("arkade"));
    expect(onSelect).toHaveBeenCalledWith("arkade");
    expect(onChoose).toHaveBeenCalledWith("arkade");
  });

  it("chooses the card already checked when it is clicked again", async () => {
    const { user, onSelect, onChoose } = showPayWith();
    await user.click(radio("cashu"));
    expect(onSelect).not.toHaveBeenCalled();
    expect(onChoose).toHaveBeenCalledWith("cashu");
  });

  it("brings up a blocked card to say why, but does not choose it", async () => {
    const { user, onSelect, onChoose } = showPayWith();
    expect(radio("bark")).toHaveAttribute("aria-disabled", "true");
    expect(radio("bark")).toHaveAttribute("title", "Bark is off in this chat");
    expect(radio("arkade")).not.toHaveAttribute("aria-disabled");
    await user.click(radio("bark"));
    expect(onSelect).toHaveBeenCalledWith("bark");
    expect(radio("bark")).toHaveAttribute("aria-checked", "true");
    expect(onChoose).not.toHaveBeenCalled();
  });

  it("selects with the arrow keys and chooses with Enter", async () => {
    const { user, onChoose } = showPayWith();
    radio("cashu").focus();
    await user.keyboard("{ArrowLeft}");
    expect(radio("usdt")).toHaveFocus();
    expect(radio("usdt")).toHaveAttribute("aria-checked", "true");
    expect(onChoose).not.toHaveBeenCalled();
    await user.keyboard("{Enter}");
    expect(onChoose).toHaveBeenCalledWith("usdt");
  });
});
