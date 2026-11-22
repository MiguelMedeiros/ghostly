import { describe, expect, it } from "vitest";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { Settings } from "../../pages/Settings";
import { renderApp } from "../render";

// covers: app.theme.on-accent

/**
 * The accent is dark in some themes (#0a0a0a in monochrome light) and white in others (monochrome dark), so no fixed
 * ink reads on it everywhere: text on `bg-accent` takes `text-on-accent`, which each theme sets in apps/ui/src/index.css.
 * The lint rule ghostly/on-accent-ink (tools/eslint/) refuses a class list that pairs them in the source; this checks
 * what Settings renders.
 */

/** A solid accent background (`bg-accent`, `!bg-accent`, `bg-accent-hover`), not a tint like `bg-accent/20`. */
const ON_ACCENT = /(?:^|\s)!?bg-accent(?:-hover)?(?=\s|$)/;
/** A fixed ink: white, black, or a hex/rgb/hsl colour in brackets. */
const FIXED_INK = /(?:^|\s)!?text-(?:white|black|\[(?:#|rgba?\(|hsla?\())[^\s]*/;

describe("text on the accent", () => {
  it("Settings' chosen options and buttons take the theme's ink on the accent", () => {
    const { container } = renderApp(
      <LockScreenProvider>
        <UpdateProvider>
          <Settings />
        </UpdateProvider>
      </LockScreenProvider>,
      { route: "/settings" },
    );
    // A switch's track is accent too, with nothing written on it: only what carries text needs the ink.
    const accented = [...container.querySelectorAll<HTMLElement>("[class]")]
      .filter((el) => ON_ACCENT.test(el.getAttribute("class")!) && el.textContent!.trim() !== "");
    expect(accented.map((el) => el.textContent!.trim())).toEqual(expect.arrayContaining(["Dark", "Compact", "Save"]));
    for (const el of accented) {
      expect(el).toHaveClass("text-on-accent");
      expect(FIXED_INK.test(el.getAttribute("class")!)).toBe(false);
    }
  });
});
