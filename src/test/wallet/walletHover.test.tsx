import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Wallet } from "../../pages/Wallet";
import { stackLayout, stackStrips } from "../../components/deck/stack";
import { walletView } from "../fakeEngine";
import { renderApp } from "../render";
import { arkReady, mint, TEST_MINT } from "../payments/fixtures";

// covers: wallet.deck

/**
 * The pointer passing over the Wallets page's cards brings each one up and its panel follows, and that is all: no
 * field takes the focus (a focus there pulled the page down to Cashu's amount in WebKit). Choosing a card, with a
 * click, is what puts the focus in its amount, without scrolling to it.
 */

/** The deck's width, as a browser would lay it out (happy-dom has no layout). */
const DECK = 800;

beforeEach(() => {
  document.documentElement.dataset.reduceMotion = "true";
  // A mouse: the deck is a stack.
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({ matches: true, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false }));
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ left: 0, right: DECK, width: DECK, top: 0, bottom: 300, height: 300, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect);
});
afterEach(() => { vi.restoreAllMocks(); });

const cards = () => [...screen.getByRole("tablist", { name: "Testnet wallets" }).querySelectorAll<HTMLElement>("[role=tab]")];
const panelOf = () => screen.getByRole("tabpanel").getAttribute("aria-labelledby");

/** The mouse moves to the middle of card `i`'s strip, the part of it that shows with the chosen card on top. */
function pointAt(i: number) {
  const all = cards(), active = all.findIndex((tab) => tab.getAttribute("aria-selected") === "true");
  const strip = stackStrips(stackLayout(DECK, all.length), active)[i];
  fireEvent.pointerMove(all[i].parentElement!, { pointerType: "mouse", clientX: (strip.left + strip.right) / 2, clientY: 100 });
}

describe("the pointer passing over the Wallets page's cards", () => {
  it("brings each card up without moving the focus; a click on a card puts it in the amount, where it is", async () => {
    const { user, engine } = renderApp(<Wallet />);
    engine.update({ wallet: walletView({ mints: [mint(TEST_MINT, 5)], ark: arkReady({ balance: 0 }) }) });
    await waitFor(() => expect(cards().length).toBe(3));
    const ids = cards().map((tab) => tab.id);
    // The page opens on a card without taking the focus: its amount is below the decks.
    await screen.findByTestId("wallet-receive-amount");
    expect(document.activeElement).toBe(document.body);
    const focus = vi.spyOn(HTMLElement.prototype, "focus");

    // Over every card, back and forth: each comes up and its panel follows, and nothing takes the focus.
    for (const i of [1, 2, 1, 0, 2, 0]) {
      pointAt(i);
      await waitFor(() => expect(panelOf()).toBe(ids[i]));
      expect(cards()[i]).toHaveAttribute("aria-selected", "true");
      expect(document.activeElement).toBe(document.body);
    }
    // Lightning's panel has the amount too: it mounts under the pointer and stays unfocused.
    pointAt(1);
    await waitFor(() => expect(panelOf()).toBe(ids[1]));
    expect(await screen.findByTestId("wallet-receive-amount")).not.toHaveFocus();
    expect(focus).not.toHaveBeenCalled();

    // A click chooses the card under the pointer: its amount takes the focus, without scrolling to it.
    await user.click(cards()[1]);
    await waitFor(() => expect(screen.getByTestId("wallet-receive-amount")).toHaveFocus());
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("a key moving along the deck keeps the focus on the cards", async () => {
    const { user, engine } = renderApp(<Wallet />);
    engine.update({ wallet: walletView({ mints: [mint(TEST_MINT, 5)], ark: arkReady({ balance: 0 }) }) });
    await waitFor(() => expect(cards().length).toBe(3));
    const ids = cards().map((tab) => tab.id);
    const start = cards().findIndex((tab) => tab.getAttribute("aria-selected") === "true");
    cards()[start].focus();
    await user.keyboard("{ArrowRight}");
    const next = (start + 1) % 3;
    await waitFor(() => expect(panelOf()).toBe(ids[next]));
    expect(cards()[next]).toHaveFocus();
  });
});
