import { screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Deck } from "../../components/deck/Deck";
import { renderApp } from "../render";

// covers: wallet.deck, proofs.deck

/** A deck of plain cards: the primitive the wallet's and the identities' decks are made of. */
interface Plain { id: string; name: string; off?: string }
const CARDS: Plain[] = [{ id: "a", name: "Alpha" }, { id: "b", name: "Bravo" }, { id: "c", name: "Charlie", off: "Not here" }, { id: "d", name: "Delta" }];

function Plain({ cards = CARDS, initial = "a", kind = "tabs", onSelect, onChoose, outside }: { cards?: Plain[]; initial?: string; kind?: "tabs" | "radios"; onSelect?: (id: string) => void; onChoose?: (id: string) => void; outside?: string }) {
  const [selected, setSelected] = useState(initial);
  return <>
    {outside && <button type="button" onClick={() => setSelected(outside)}>Choose from outside</button>}
    <Deck<Plain> cards={cards} selected={selected} onSelect={id => { onSelect?.(id); setSelected(id); }} onChoose={onChoose}
      kind={kind} panel={{ id: "plain-panel", tabId: id => `plain-tab-${id}` }} label="Plain cards" name="plain-deck" className="plain-deck"
      testId={card => `plain-${card.id}`} blocked={card => card.off}
      face={(card, { active, after }) => <span data-deck="face" data-face-active={active} data-after={after || undefined}>{card.name}<span data-deck="sheen" /><span data-deck="ghost" /></span>}
      mark={card => <i data-mark={card.id} />} tone={card => `tone-${card.id}`} />
  </>;
}
/** Rendered as the app renders it, which applies the profile's own reduced-motion setting (off) as it mounts. */
const show = (props: Parameters<typeof Plain>[0] = {}, reduce = true) => {
  const onSelect = vi.fn(), onChoose = vi.fn();
  const shown = renderApp(<Plain onSelect={onSelect} onChoose={onChoose} {...props} />);
  if (reduce) document.documentElement.dataset.reduceMotion = "true";
  return { ...shown, onSelect, onChoose };
};
const card = (id: string) => screen.getByTestId(`plain-${id}`);
const deck = () => document.querySelector<HTMLElement>(".deck")!;
const chosen = () => screen.getAllByRole("tab").filter(t => t.getAttribute("aria-selected") === "true").map(t => t.dataset.testid);

describe("the deck primitive", () => {
  it("is a tablist over a panel, each card a tab that names the panel, with only the chosen one in the tab order", () => {
    show({ initial: "b" });
    expect(screen.getByRole("tablist", { name: "Plain cards" })).toBeInTheDocument();
    expect(screen.getAllByRole("tab").map(t => t.id)).toEqual(["plain-tab-a", "plain-tab-b", "plain-tab-c", "plain-tab-d"]);
    expect(card("b")).toHaveAttribute("aria-controls", "plain-panel");
    expect(chosen()).toEqual(["plain-b"]);
    expect(screen.getAllByRole("tab").map(t => t.tabIndex)).toEqual([-1, 0, -1, -1]);
  });

  it("is a radiogroup when the cards are a choice", () => {
    show({ kind: "radios" });
    expect(screen.getByRole("radiogroup", { name: "Plain cards" })).toBeInTheDocument();
    expect(card("a")).toHaveAttribute("aria-checked", "true");
    expect(card("a")).not.toHaveAttribute("aria-controls");
  });

  it("gives each face its place: the chosen one active, the ones after it marked as after", () => {
    show({ initial: "b" });
    expect(["a", "b", "c", "d"].map(id => card(id).querySelector("[data-deck=face]")!.getAttribute("data-face-active"))).toEqual(["false", "true", "false", "false"]);
    expect(["a", "b", "c", "d"].map(id => card(id).querySelector("[data-deck=face]")!.hasAttribute("data-after"))).toEqual([false, false, true, true]);
  });

  it("wears its kind as a class on itself and its parts, each card's tone on the card, and the chosen one's on the deck", async () => {
    const { user } = show();
    expect(deck()).toHaveClass("deck", "plain-deck", "tone-a");
    for (const part of ["glow", "track", "nav", "marks"]) expect(document.querySelector(`.deck-${part}.plain-deck-${part}`)).not.toBeNull();
    expect(card("b")).toHaveClass("deck-card", "plain-deck-card", "tone-b");
    await user.click(card("d"));
    expect(deck()).toHaveClass("tone-d");
    expect(deck()).not.toHaveClass("tone-a");
  });

  it("marks every card under the deck, the chosen one lit", async () => {
    const { user } = show();
    const marks = () => [...document.querySelectorAll<HTMLElement>(".deck-marks > span")];
    expect(marks().map(m => m.querySelector("i")!.dataset.mark)).toEqual(["a", "b", "c", "d"]);
    expect(marks().map(m => m.dataset.on)).toEqual(["true", "false", "false", "false"]);
    await user.click(screen.getByTestId("plain-deck-next"));
    expect(marks().map(m => m.dataset.on)).toEqual(["false", "true", "false", "false"]);
  });

  it("has no arrows or marks for a single card", () => {
    show({ cards: [CARDS[0]] });
    expect(screen.queryByTestId("plain-deck-next")).not.toBeInTheDocument();
    expect(document.querySelector(".deck-marks")).toBeNull();
  });

  it.each([
    ["ArrowRight", "a", "b"], ["ArrowDown", "a", "b"], ["ArrowLeft", "a", "d"], ["ArrowUp", "c", "b"], ["ArrowRight", "d", "a"], ["Home", "c", "a"], ["End", "a", "d"],
  ] as const)("%s from %s moves to %s, and the focus follows", async (key, from, to) => {
    const { user, onSelect } = show({ initial: from });
    card(from).focus();
    await user.keyboard(`{${key}}`);
    expect(onSelect).toHaveBeenCalledWith(to);
    expect(chosen()).toEqual([`plain-${to}`]);
    expect(card(to)).toHaveFocus();
  });

  it("chooses a card on click or Enter, but not one that cannot be used here, which still comes up to say why", async () => {
    const { user, onSelect, onChoose } = show();
    await user.click(card("b"));
    expect(onChoose).toHaveBeenLastCalledWith("b");
    await user.keyboard("{Enter}");
    expect(onChoose).toHaveBeenCalledTimes(2);
    expect(card("c")).toHaveAttribute("aria-disabled", "true");
    expect(card("c")).toHaveAttribute("title", "Not here");
    await user.click(card("c"));
    expect(onSelect).toHaveBeenLastCalledWith("c");
    expect(onChoose).toHaveBeenCalledTimes(2);
  });

  it("follows a choice made outside it", async () => {
    const { user } = show({ outside: "d" });
    await user.click(screen.getByRole("button", { name: "Choose from outside" }));
    expect(chosen()).toEqual(["plain-d"]);
  });
});

describe("the deck's switch motion", () => {
  const animate = vi.fn((..._args: Parameters<Element["animate"]>) => ({ cancel() {} }) as unknown as Animation);
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, "animate", { value: animate, configurable: true, writable: true });
    Object.defineProperty(HTMLElement.prototype, "getAnimations", { value: () => [], configurable: true, writable: true });
    animate.mockClear();
  });
  afterEach(() => {
    delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
    delete (HTMLElement.prototype as Partial<HTMLElement>).getAnimations;
  });
  const moved = () => animate.mock.contexts.map(el => (el as HTMLElement).dataset.deck ?? (el as HTMLElement).className);

  it("swings the new card's face up, tucks the old one back, and moves its sheen, its ghost and the glow", async () => {
    const { user } = show({}, false);
    expect(animate).not.toHaveBeenCalled();
    await user.click(card("b"));
    const faces = animate.mock.contexts.filter(el => (el as HTMLElement).dataset.deck === "face").map(el => (el as HTMLElement).textContent);
    expect(faces).toEqual(["Bravo", "Alpha"]);
    expect(moved()).toEqual(expect.arrayContaining(["sheen", "ghost", "deck-glow plain-deck-glow"]));
    // The swings are added on top of the lift, never replacing it.
    expect(animate.mock.calls[0][1]).toMatchObject({ composite: "add" });
  });

  it("plays nothing with reduced motion", async () => {
    const { user } = show();
    await user.click(card("b"));
    expect(animate).not.toHaveBeenCalled();
  });

  // A screen-blended sheen crossing a card that swings (the face's rotate) was drawn by Chrome against a shifted copy
  // of the card: a second card edge, with square corners, on the side the light came in from. Only pixels show it
  // (website/e2e/wallet-deck.spec.ts films a switch); this keeps the blend mode from coming back on any deck's sheen.
  it("lights the new card with plain alpha: no stylesheet gives a sheen a blend mode", () => {
    const sheets = ["deck/deck.css", "wallet-deck.css", "identities/id-deck.css"];
    const sheenRules = sheets.flatMap(sheet => {
      const css = readFileSync(join(import.meta.dirname, "../../components", sheet), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, selector]) => /sheen/.test(selector)).map(([, selector, body]) => ({ sheet, selector: selector.trim(), body }));
    });
    // The deck's own rule, and each face's (the identities raise theirs over the seal).
    expect(sheenRules.map(rule => rule.selector)).toEqual(expect.arrayContaining(["[data-deck=sheen]", ".id-card-sheen"]));
    expect(sheenRules.filter(rule => /mix-blend-mode/.test(rule.body))).toEqual([]);
  });
});

/** A deck of checks: any number of cards on, as a chat's Accept side holds them. */
function Checks({ initial = ["a", "c"], onChoose }: { initial?: string[]; onChoose?: (id: string) => void }) {
  const [selected, setSelected] = useState("a");
  const [on, setOn] = useState(new Set(initial));
  return <Deck<Plain> cards={CARDS.map(c => ({ ...c, off: undefined }))} selected={selected} onSelect={setSelected}
    onChoose={id => { onChoose?.(id); setOn(s => { const next = new Set(s); if (next.has(id)) next.delete(id); else next.add(id); return next; }); }}
    kind="checks" checked={c => on.has(c.id)} label="Ways on" name="checks-deck" className="plain-deck" testId={c => `check-${c.id}`}
    face={(c, { checked }) => <span data-deck="face" data-face-checked={String(checked)}>{c.name}</span>} mark={c => <i data-mark={c.id} />} tone={c => `tone-${c.id}`} />;
}

describe("a deck of checks", () => {
  const check = (id: string) => screen.getByTestId(`check-${id}`);
  const showChecks = (props: Parameters<typeof Checks>[0] = {}) => {
    const shown = renderApp(<Checks {...props} />);
    document.documentElement.dataset.reduceMotion = "true";
    return shown;
  };

  it("is a group of switches, any number of them on, each face told whether it is on", () => {
    showChecks();
    expect(screen.getByRole("group", { name: "Ways on" })).toBeInTheDocument();
    expect(screen.getAllByRole("switch").map(c => c.getAttribute("aria-checked"))).toEqual(["true", "false", "true", "false"]);
    expect(check("c").querySelector("[data-deck=face]")).toHaveAttribute("data-face-checked", "true");
    expect(check("b").querySelector("[data-deck=face]")).toHaveAttribute("data-face-checked", "false");
    // Only the card in front is in the tab order, as in every deck.
    expect(screen.getAllByRole("switch").map(c => c.tabIndex)).toEqual([0, -1, -1, -1]);
  });

  it("raises the cards that are on, less than the one in front, and leaves the others down", () => {
    showChecks();
    expect(check("a").style.getPropertyValue("--y")).toBe("-9px");
    expect(check("c").style.getPropertyValue("--y")).toBe("-5px");
    expect(check("b").style.getPropertyValue("--y")).toBe("0px");
    expect(check("c")).toHaveAttribute("data-checked", "true");
    // The marks under the deck say which are on too.
    expect([...document.querySelectorAll(".deck-marks span")].map(m => m.getAttribute("data-checked"))).toEqual(["true", "false", "true", "false"]);
  });

  it("turns a card on or off with a click, Space or Enter, and moves with the arrows without turning anything", async () => {
    const onChoose = vi.fn();
    const { user } = showChecks({ onChoose });
    await user.click(check("b"));
    expect(check("b")).toHaveAttribute("aria-checked", "true");
    expect(check("b")).toHaveAttribute("data-active", "true");
    await user.keyboard("{ArrowRight}");
    expect(check("c")).toHaveFocus();
    expect(check("c")).toHaveAttribute("aria-checked", "true");
    await user.keyboard(" ");
    expect(check("c")).toHaveAttribute("aria-checked", "false");
    await user.keyboard("{Enter}");
    expect(check("c")).toHaveAttribute("aria-checked", "true");
    expect(onChoose.mock.calls.map(([id]) => id)).toEqual(["b", "c", "c"]);
  });
});
