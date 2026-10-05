import { act, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useLabelsFit } from "../../hooks/useLabelsFit";

// covers: app.mobile-layout

/** Widths as a browser would lay them out: the header's, the logo's, and the buttons' with or without their words. */
const sizes = { header: 375, logo: 121, words: 243, bare: 84 };
let resized: (() => void) | undefined;

function Header({ language }: { language: string }) {
  const header = useRef<HTMLDivElement>(null), logo = useRef<HTMLDivElement>(null), buttons = useRef<HTMLDivElement>(null);
  const fit = useLabelsFit(header, logo, buttons, language);
  return (
    <div ref={header} data-testid="header" data-fit={String(fit)} style={{ paddingLeft: "16px", paddingRight: "16px" }}>
      <div ref={logo} />
      <div ref={buttons} data-words={String(fit)} />
    </div>
  );
}

function lay() {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.dataset.testid === "header" ? sizes.header : 0;
  });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
    if (this.dataset.words !== undefined) return this.dataset.words === "true" ? sizes.words : sizes.bare;
    return this.dataset.testid === "header" ? sizes.header : sizes.logo;
  });
  vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { resized = callback; } observe() {} disconnect() {} });
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("useLabelsFit", () => {
  it("keeps the words while logo, words and 8px fit, drops them when not, and brings them back on a wider header", () => {
    lay();
    sizes.header = 430; sizes.words = 243;
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
    sizes.header = 375; sizes.words = 243;
    const { rerender } = render(<Header language="fr" />);
    expect(screen.getByTestId("header").dataset.fit).toBe("false");
    sizes.words = 190;
    rerender(<Header language="en" />);
    expect(screen.getByTestId("header").dataset.fit).toBe("true");
  });
});
