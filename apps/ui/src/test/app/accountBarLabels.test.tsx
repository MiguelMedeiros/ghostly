import { act, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountBar } from "../../components/AccountBar";
import { currentProfile, renameProfile } from "../../lib/profiles";
import { renderApp } from "../render";

// covers: app.responsive, app.sidebar-resize

/**
 * happy-dom lays nothing out, so this is a model of the account bar's row: every place is `place` px wide, and a
 * label's text is 5.4 px a character (10px system font, about; "Configurações" is 70.2 px in WebKit, 70.2 here).
 * The ResizeObserver is one the test fires by hand.
 */
let place = 77.4;
const textWidth = (text: string) => text.length * 5.4;
let resizeCallbacks: ResizeObserverCallback[] = [];
let observedElements: Element[] = [];
const resized = (width: number) => act(() => {
  place = width;
  for (const callback of resizeCallbacks) callback([], {} as ResizeObserver);
});

beforeEach(() => {
  place = 77.4;
  resizeCallbacks = [];
  observedElements = [];
  vi.spyOn(Range.prototype, "getBoundingClientRect").mockImplementation(function (this: Range) {
    return new DOMRect(0, 0, textWidth(this.startContainer.textContent ?? ""), 12);
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return new DOMRect(0, 0, this.matches("button.account-action") ? place : 0, 45);
  });
  vi.stubGlobal("ResizeObserver", class {
    private readonly callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) { this.callback = callback; resizeCallbacks.push(callback); }
    observe(element: Element) { observedElements.push(element); }
    unobserve() {}
    disconnect() { resizeCallbacks = resizeCallbacks.filter((callback) => callback !== this.callback); }
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  act(() => renameProfile(currentProfile().id, "Personal"));
});

// Named in the app's language: "Account", "Conta" in Portuguese.
const bar = () => screen.getByRole("navigation", { name: /^(Account|Conta)$/ });
const labels = () => [...bar().querySelectorAll(".account-label")].map((label) => label.textContent);

/** The labels under the five places: shown whenever the places' names fit, all hidden when one would be cut. */
describe("the account bar's labels", () => {
  it("show at the list's default width, in English and in Portuguese", () => {
    const { unmount } = renderApp(<AccountBar />);
    expect(labels()).toEqual(["Personal", "Wallets", "Identities", "Services", "Settings"]);
    expect(bar()).not.toHaveAttribute("data-compact");
    unmount();

    renderApp(<AccountBar />, { language: "pt" });
    expect(labels()).toEqual(["Personal", "Carteiras", "Identidades", "Serviços", "Configurações"]);
    expect(bar()).not.toHaveAttribute("data-compact");
  });

  it("step aside together when a place's name would be cut, and come back when the list is wider", () => {
    place = 49.4;
    renderApp(<AccountBar />, { language: "pt" });
    expect(bar()).toHaveAttribute("data-compact", "true");

    resized(77.4);
    expect(bar()).not.toHaveAttribute("data-compact");
    resized(69);
    expect(bar()).toHaveAttribute("data-compact", "true");
  });

  it("are not hidden by a profile name wider than its place: the name ends in an ellipsis, whole in its tooltip", () => {
    renderApp(<AccountBar />, { language: "pt" });
    act(() => renameProfile(currentProfile().id, "This is Fine, really, all fine"));
    expect(textWidth("This is Fine, really, all fine")).toBeGreaterThan(place);
    expect(bar()).not.toHaveAttribute("data-compact");
    expect(screen.getByTestId("account-profile")).toHaveAttribute("title", "Perfil: This is Fine, really, all fine");
  });

  it("are measured again when a place appears, though the row keeps its width", () => {
    renderApp(<AccountBar />);
    const buttons = [...bar().querySelectorAll("button")];
    expect(buttons).toHaveLength(5);
    for (const button of buttons) expect(observedElements).toContain(button);
    expect(observedElements).toContain(bar());
  });
});
