import { act, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useLabelsFit } from "../../hooks/useLabelsFit";

// covers: app.mobile-layout

/**
 * Widths as a browser would lay them out: the header's, the logo's with and without its wordmark, and the buttons' with
 * their words, without them, and without them with Join at its own width.
 */
const sizes = { header: 375, logo: 121, mark: 36, words: 243, bare: 84, own: 70 };
let resized: (() => void) | undefined;

function Header({ language, steps }: { language: string; steps?: number }) {
  const header = useRef<HTMLDivElement>(null), logo = useRef<HTMLDivElement>(null), buttons = useRef<HTMLDivElement>(null);
  const given = useLabelsFit(header, logo, buttons, language, 8, steps);
  return (
    <div ref={header} data-testid="header" data-fit={String(given === 0)} data-given={given} style={{ paddingLeft: "16px", paddingRight: "16px" }}>
      <div ref={logo} data-mark={String(given >= 2)} />
      <div ref={buttons} data-words={String(given === 0)} data-own={String(given >= 3)} />
    </div>
  );
}

function lay() {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.dataset.testid === "header" ? sizes.header : 0;
  });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
    if (this.dataset.words !== undefined) return this.dataset.words === "true" ? sizes.words : this.dataset.own === "true" ? sizes.own : sizes.bare;
    if (this.dataset.mark !== undefined) return this.dataset.mark === "true" ? sizes.mark : sizes.logo;
    return this.dataset.testid === "header" ? sizes.header : sizes.logo;
  });
  vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { resized = callback; } observe() {} disconnect() {} });
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.documentElement.style.fontSize = ""; });

describe("useLabelsFit", () => {
  it("keeps the words while logo, words and 8px fit, drops them when not, and brings them back on a wider header", () => {
    lay();
    Object.assign(sizes, { header: 430, logo: 121, words: 243, bare: 84 });
    const { rerender } = render(<Header language="fr" />);
    expect(screen.getByTestId("header").dataset.fit).toBe("true");

    // French on a 375px phone: 121 + 243 + 8 > 343.
    sizes.header = 375;
    act(() => resized?.());
    expect(screen.getByTestId("header").dataset.fit).toBe("false");
    // Without its words the row fits; it stays so at the same width.
    act(() => resized?.());
    expect(screen.getByTestId("header").dataset.fit).toBe("false");

    // Turned on its side: the words come back.
    sizes.header = 812;
    act(() => resized?.());
    expect(screen.getByTestId("header").dataset.fit).toBe("true");

    // English, with shorter words, at 375px: they fit.
    sizes.header = 375; sizes.words = 190;
    rerender(<Header language="en" />);
    act(() => resized?.());
    expect(screen.getByTestId("header").dataset.fit).toBe("true");
  });

  it("starts over with the words when the language changes", () => {
    lay();
    Object.assign(sizes, { header: 375, logo: 121, words: 243, bare: 84 });
    const { rerender } = render(<Header language="fr" />);
    expect(screen.getByTestId("header").dataset.fit).toBe("false");
    sizes.words = 190;
    rerender(<Header language="en" />);
    expect(screen.getByTestId("header").dataset.fit).toBe("true");
  });

  it("with only one step, gives up the words and nothing more, though the row still does not fit", () => {
    lay();
    Object.assign(sizes, { header: 375, logo: 165, words: 300, bare: 234 });
    render(<Header language="en" />);
    expect(screen.getByTestId("header").dataset.given).toBe("1");
  });

  it("on a phone at a larger text size gives up the next step until the row fits, and a smaller text brings them back", () => {
    lay();
    // A 375px phone at 24px text, as measured: the ghost and GHOSTLY 165, New with its arrow and Join without words 234,
    // 48 of padding: 165 + 234 + 8 > 327. Without the wordmark the ghost is 36: 36 + 234 + 8 fits.
    Object.assign(sizes, { header: 375, logo: 165, mark: 36, words: 300, bare: 234, own: 186 });
    document.documentElement.style.fontSize = "24px";
    const { container } = render(<Header language="en" steps={3} />);
    const header = screen.getByTestId("header");
    header.style.paddingLeft = header.style.paddingRight = "24px";
    act(() => resized?.());
    expect(header.dataset.given).toBe("2");

    // At 32px text (and 32 of padding each side) Join's share of New's width goes too: 36 + 312 + 8 > 311, 36 + 248 + 8 fits.
    document.documentElement.style.fontSize = "32px";
    header.style.paddingLeft = header.style.paddingRight = "32px";
    Object.assign(sizes, { bare: 312, own: 248 });
    act(() => resized?.());
    expect(header.dataset.given).toBe("3");
    act(() => resized?.());
    expect(header.dataset.given).toBe("3");

    // Back to 16px text, the same 375px: as wide as 23.4rem, wider than 11.7rem when they went. All of it comes back.
    document.documentElement.style.fontSize = "16px";
    header.style.paddingLeft = header.style.paddingRight = "16px";
    Object.assign(sizes, { logo: 121, words: 190, bare: 84, own: 70 });
    act(() => resized?.());
    expect(header.dataset.given).toBe("0");
    expect(container.querySelector("[data-words]")?.getAttribute("data-words")).toBe("true");
  });
});
