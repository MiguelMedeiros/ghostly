import { act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "../../contexts/ThemeContext";
import { useSettings } from "../../contexts/SettingsContext";
import type { ColorScheme } from "../../lib/settings";
import { setWindowThemeSink, windowThemeFor } from "../../lib/windowTheme";
import { renderApp } from "../render";

// covers: app.theme.title-bar

/*
 * Desktop's title bar takes the app's Light / Dark choice, not the system's: the Desktop host gives the window the
 * appearance the setting asks for, and System gives it back to the system (no theme).
 */

afterEach(() => setWindowThemeSink(null));

describe("the window's appearance", () => {
  it("is the app's Light or Dark, and none of its own for System", () => {
    expect(windowThemeFor("light")).toBe("light");
    expect(windowThemeFor("dark")).toBe("dark");
    expect(windowThemeFor("system")).toBeNull();
  });

  it("is set when the app starts and each time the choice changes, and never without a window to set", () => {
    const sink = vi.fn();
    setWindowThemeSink(sink);
    let choose: (scheme: ColorScheme) => void = () => {};
    function Chooser() {
      choose = useSettings().updateColorScheme;
      return null;
    }
    renderApp(<ThemeProvider><Chooser /></ThemeProvider>);
    // A new profile's default is Dark.
    expect(sink.mock.calls).toEqual([["dark"]]);
    act(() => choose("light"));
    act(() => choose("system"));
    act(() => choose("dark"));
    expect(sink.mock.calls).toEqual([["dark"], ["light"], [null], ["dark"]]);

    setWindowThemeSink(null);
    expect(() => act(() => choose("light"))).not.toThrow();
    expect(sink).toHaveBeenCalledTimes(4);
  });
});
