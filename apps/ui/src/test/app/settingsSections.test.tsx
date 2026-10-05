import { screen } from "@testing-library/react";
import { Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { useAnchorHome, useAppNavigation } from "../../hooks/useAppNavigation";
import { HOME, anchorTarget, plan, readNav, stackOf } from "../../lib/navigation";
import { SETTINGS_INDEX, searchSettings, sectionInView, settingsSection } from "../../lib/settingsSections";
import { Settings } from "../../pages/Settings";
import { renderApp } from "../render";
import { windowIs } from "../viewport";
import en from "../../locales/en";
import { locales } from "../../locales";
import { translateWith } from "../../locales/translate";
import type { Language } from "../../lib/settings";

// covers: settings.sections

/** The app around Settings: the tab bar's way there, the browser's Back, and home put under a deep link. */
function Harness() {
  useAnchorHome(() => false);
  const nav = useAppNavigation();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  return (
    <>
      <p data-testid="where">{pathname}</p>
      <button onClick={() => nav.place("/settings")}>Settings tab</button>
      <button onClick={() => void navigate(-1)}>Browser back</button>
      <Routes>
        <Route path="/" element={<p>Home</p>} />
        <Route path="/settings/:section?" element={<Settings />} />
        <Route path="/profile" element={<p>Profile page</p>} />
      </Routes>
    </>
  );
}

const renderSettings = (route = "/") => renderApp(<LockScreenProvider><UpdateProvider><Harness /></UpdateProvider></LockScreenProvider>, { route });
const where = () => screen.getByTestId("where").textContent;

// The app's own address is `#/` once open: `useAnchorHome` would otherwise keep writing it (the router here is in memory).
beforeEach(() => { window.location.hash = "#/"; });
afterEach(() => vi.restoreAllMocks());

describe("Settings on a phone", () => {
  it("opens as a menu of sections, with no options of its own", async () => {
    windowIs(true);
    const { user } = renderSettings();
    await user.click(screen.getByRole("button", { name: "Settings tab" }));
    expect(screen.getByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument();
    const menu = screen.getByTestId("settings-menu");
    for (const name of ["Profile", "Appearance", "Notifications", "Privacy & security", "Network", "Data & storage", "About"]) {
      expect(menu).toHaveTextContent(name);
    }
    // What a section holds now, on its line.
    expect(screen.getByTestId("settings-open-appearance")).toHaveTextContent("English");
    expect(screen.getByTestId("settings-open-about")).toHaveTextContent("Version");
    expect(screen.queryByTestId("settings-sounds")).not.toBeInTheDocument();
    expect(screen.queryByTestId("settings-lock")).not.toBeInTheDocument();
  });

  it("opens a section on its own screen; its Back and the browser's return to the menu", async () => {
    windowIs(true);
    const { user } = renderSettings();
    await user.click(screen.getByRole("button", { name: "Settings tab" }));
    await user.click(screen.getByTestId("settings-open-appearance"));
    expect(where()).toBe("/settings/appearance");
    expect(screen.getByRole("heading", { level: 1, name: "Appearance" })).toBeInTheDocument();
    expect(screen.getByTestId("settings-language")).toBeInTheDocument();
    expect(screen.getByTestId("chat-list-density")).toBeInTheDocument();
    // Only this section: nothing of the others.
    expect(screen.queryByTestId("settings-sounds")).not.toBeInTheDocument();
    expect(screen.queryByTestId("settings-menu")).not.toBeInTheDocument();
    expect(screen.getByTestId("page-back")).toHaveAttribute("data-goes", "up");

    await user.click(screen.getByTestId("page-back"));
    expect(where()).toBe("/settings");
    expect(screen.getByTestId("settings-menu")).toBeInTheDocument();

    await user.click(screen.getByTestId("settings-open-privacy"));
    expect(screen.getByTestId("settings-lock")).toBeInTheDocument();
    expect(screen.getByTestId("settings-link-previews")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Browser back" }));
    expect(where()).toBe("/settings");
    expect(screen.getByTestId("settings-menu")).toBeInTheDocument();
  });

  it("keeps the key options a tap away", async () => {
    windowIs(true);
    const { user } = renderSettings();
    await user.click(screen.getByRole("button", { name: "Settings tab" }));
    const reach = async (section: string, testId: string) => {
      await user.click(screen.getByTestId(`settings-open-${section}`));
      expect(screen.getByTestId(testId)).toBeInTheDocument();
      await user.click(screen.getByTestId("page-back"));
    };
    await user.click(screen.getByTestId("settings-open-profile"));
    expect(screen.getByLabelText("Name in chats")).toBeInTheDocument();
    await user.click(screen.getByTestId("page-back"));
    await reach("notifications", "settings-system-notifications");
    await reach("network", "network-relays-field");
    await reach("storage", "clear-all-data");
    await reach("about", "settings-about-version");
  });

  it("an old address opens its new place, with Back to the menu", async () => {
    windowIs(true);
    const { user } = renderSettings("/settings/advanced");
    expect(await screen.findByTestId("network-relays-field")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Network" })).toBeInTheDocument();
    expect(where()).toBe("/settings/network");
    expect(screen.getByTestId("page-back")).toHaveAttribute("data-goes", "up");
    await user.click(screen.getByTestId("page-back"));
    expect(where()).toBe("/settings");
    await user.click(screen.getByTestId("page-back"));
    expect(where()).toBe(HOME);
  });

  it("finds an option by name and opens its section", async () => {
    windowIs(true);
    const { user } = renderSettings();
    await user.click(screen.getByRole("button", { name: "Settings tab" }));
    await user.type(screen.getByTestId("settings-search"), "lang");
    const results = screen.getAllByTestId("settings-search-result");
    expect(results).toHaveLength(1);
    expect(results[0]).toHaveTextContent("Language");
    expect(results[0]).toHaveTextContent("Appearance");
    await user.click(results[0]);
    expect(where()).toBe("/settings/appearance");

    await user.click(screen.getByTestId("page-back"));
    await user.clear(screen.getByTestId("settings-search"));
    await user.type(screen.getByTestId("settings-search"), "nothing like this");
    expect(screen.getByTestId("settings-search-empty")).toHaveTextContent("No settings match");
  });
});

describe("Settings on a wide screen", () => {
  it("keeps every section on one page, with an index beside it", () => {
    windowIs(false);
    renderSettings("/settings");
    expect(screen.getByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument();
    expect(screen.getByTestId("settings-index")).toBeInTheDocument();
    expect(screen.queryByTestId("settings-menu")).not.toBeInTheDocument();
    for (const testId of ["settings-language", "settings-sounds", "settings-lock", "network-relays-field", "clear-all-data", "settings-about-version"]) {
      expect(screen.getByTestId(testId)).toBeInTheDocument();
    }
  });

  it("picking a section in the index names it in the address", async () => {
    windowIs(false);
    const { user } = renderSettings("/settings");
    await user.click(screen.getByTestId("settings-index-privacy"));
    expect(where()).toBe("/settings/privacy");
    expect(screen.getByTestId("settings-index-privacy")).toHaveAttribute("aria-current", "true");
    // Still the whole page.
    expect(screen.getByTestId("settings-sounds")).toBeInTheDocument();
  });

  it("an old address shows the whole page too", async () => {
    windowIs(false);
    renderSettings("/settings/advanced");
    expect(await screen.findByTestId("network-relays-field")).toBeInTheDocument();
    expect(screen.getByTestId("settings-sounds")).toBeInTheDocument();
  });
});

describe("settings sections", () => {
  it("a section's deep link gets Settings and home under it", () => {
    expect(anchorTarget("/settings/appearance")).toEqual([{ path: HOME }, { path: "/settings" }, { path: "/settings/appearance", up: true }]);
    expect(anchorTarget("/wallet")).toEqual([{ path: HOME }, { path: "/wallet" }]);
    const steps = plan(stackOf("/settings/network", null), anchorTarget("/settings/network"));
    expect(steps).toMatchObject({ back: 0, replace: { path: HOME }, push: [{ path: "/settings" }, { path: "/settings/network" }] });
    expect(readNav(steps.push[1].state)).toEqual({ below: [{ path: "/settings" }], up: true });
  });

  it("reads an address's section, an old one's new place included", () => {
    expect(settingsSection("appearance")).toBe("appearance");
    expect(settingsSection("advanced")).toBe("network");
    expect(settingsSection("nope")).toBeNull();
    expect(settingsSection(undefined)).toBeNull();
  });

  it("the wide index marks the section picked while it is in view, else the one at the page's top, and the last at its end", () => {
    // The last three sections at the page's end: Network's top passed the line (148), Data & storage and About are below it.
    const boxes = [
      { section: "privacy", top: -600, bottom: -100 },
      { section: "network", top: -90, bottom: 400 },
      { section: "storage", top: 410, bottom: 640 },
      { section: "about", top: 650, bottom: 800 },
    ] as const;
    expect(sectionInView(boxes, 148, 800, true, "about")).toBe("about");
    expect(sectionInView(boxes, 148, 800, true, "storage")).toBe("storage");
    // Picked, and the page has since grown under it (options still loading): still the one picked.
    expect(sectionInView(boxes, 148, 800, false, "about")).toBe("about");
    // Nothing picked, or scrolled by hand since: the one at the top, and the last at the end.
    expect(sectionInView(boxes, 148, 800, false, null)).toBe("network");
    expect(sectionInView(boxes, 148, 800, true, null)).toBe("about");
    // Picked, but out of view: the same rules.
    expect(sectionInView(boxes, 148, 800, false, "privacy")).toBe("network");
    // Above the first section: the first.
    expect(sectionInView([{ section: "profile", top: 200, bottom: 400 }], 148, 800, false, null)).toBe("profile");
  });

  it("finds an option by the words people look for it by, not only its label, in the language shown", () => {
    const found = (language: Language, query: string) => searchSettings(query, translateWith(locales[language], language), () => true).map((entry) => entry.label);
    expect(found("en", "dark")).toEqual(["settings.colorScheme"]);
    expect(found("en", "theme")).toEqual(["settings.colorTheme", "settings.colorScheme"]);
    expect(found("en", "colour")).toEqual(["settings.colorTheme"]);
    expect(found("en", "password")).toEqual(["settings.lockScreen", "settings.password"]);
    expect(found("en", "mentions")).toEqual(["settings.cues.chat"]);
    expect(found("pt", "escuro")).toEqual(["settings.colorScheme"]);
    expect(found("zh", "深色")).toEqual(["settings.colorScheme"]);
    expect(found("ar", "داكن")).toEqual(["settings.colorScheme"]);
    // Words of another language are not found: the search is in the language shown.
    expect(found("pt", "dark")).toEqual([]);
  });

  it("every option the search knows has an English label, and search ignores case and accents", () => {
    const t = (key: string) => key.split(".").reduce<unknown>((at, part) => (at as Record<string, unknown>)?.[part], en) as string;
    for (const entry of SETTINGS_INDEX) {
      expect(typeof t(entry.label), entry.label).toBe("string");
      if (entry.words) expect(typeof t(entry.words), entry.words).toBe("string");
    }
    expect(searchSettings("LOCK", t, () => true).map((entry) => entry.label)).toContain("settings.lockScreen");
    const accents = (key: string) => (key === "settings.language" ? "Língua" : t(key));
    expect(searchSettings("lingua", accents, () => true).map((entry) => entry.label)).toEqual(["settings.language"]);
    // An option this device lacks is not offered.
    expect(searchSettings("update", t, (needs) => needs !== "updates").map((entry) => entry.label)).not.toContain("updates.auto");
  });
});
