import { afterEach, describe, expect, it, vi } from "vitest";
import { switchTheme } from "../../contexts/ThemeContext";

// covers: app.theme

const root = document.documentElement;

afterEach(() => vi.restoreAllMocks());

describe("switchTheme", () => {
  it("takes the new theme's colors with transitions off, then gives them back", () => {
    switchTheme("dark", "classic");
    // What the browser sees when it is made to take the new colors: the switch attribute is on.
    const seen: (string | null)[] = [];
    vi.spyOn(window, "getComputedStyle").mockImplementation((element) => {
      seen.push(`${(element as Element).getAttribute("data-theme")} ${(element as Element).getAttribute("data-color-theme")} ${(element as Element).hasAttribute("data-theme-switch")}`);
      return { color: "" } as CSSStyleDeclaration;
    });
    switchTheme("light", "purple");
    expect(seen).toEqual(["light purple true"]);
    expect(root.getAttribute("data-theme")).toBe("light");
    expect(root.getAttribute("data-color-theme")).toBe("purple");
    expect(root.style.colorScheme).toBe("light");
    expect(root.hasAttribute("data-theme-switch")).toBe(false);
  });

  it("restyles nothing when the theme is already the one on the page", () => {
    switchTheme("dark", "cyan");
    const computed = vi.spyOn(window, "getComputedStyle");
    switchTheme("dark", "cyan");
    expect(computed).not.toHaveBeenCalled();
    expect(root.hasAttribute("data-theme-switch")).toBe(false);
  });
});
