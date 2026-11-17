import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Root } from "../../Root";
import { ProfileSwitchSplash } from "../../components/ProfileSwitchSplash";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { announceSwitch, createProfile, settingsKeyFor } from "../../lib/profiles";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";
import { windowIs } from "../viewport";

// covers: profiles.switcher

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {}, warmSound: () => {} }));

/**
 * The profile switch overlay covers the whole page until the profile opened has something to show (up to 8 s on a page
 * that follows a switch). What is under it must be out of reach of the keys and of a screen reader meanwhile, and the
 * words say when the switch was made in another tab of the app.
 */

/** What Tab can reach: no control inside something inert, hidden or disabled. */
const tabbable = (root: ParentNode) => [...root.querySelectorAll<HTMLElement>("button, a[href], input, textarea, select, [tabindex]:not([tabindex='-1'])")]
  .filter((el) => !el.hasAttribute("disabled") && !el.closest("[inert]") && !el.closest("[hidden]") && !el.closest(".hidden"));
const outsideOverlay = () => {
  const splash = screen.getByTestId("profile-switch-splash");
  return tabbable(document.body).filter((el) => !splash.contains(el));
};
const pendingIn = (name: string, more: Record<string, unknown> = {}) =>
  sessionStorage.setItem("ghostly_switching", JSON.stringify({ id: "", name, color: "#22d3ee", at: Date.now(), ...more }));

/** A page under the overlay: a control first, then the open page's `main`, which the skip link focuses. */
function Page() {
  return (
    <>
      <button type="button">Before</button>
      <main data-testid="page-main" tabIndex={-1}><button type="button">New chat</button></main>
    </>
  );
}

const WORDS: Record<"en" | "ar", { opening: string; elsewhere: (name: string) => string }> = {
  en: { opening: "Opening \u2068Work\u2069…", elsewhere: (name) => `Another Ghostly tab opened ${name}…` },
  ar: { opening: "جارٍ فتح \u2068Work\u2069…", elsewhere: (name) => `فتحت علامة تبويب أخرى لـ Ghostly ${name}…` },
};

beforeEach(() => {
  fakeEngine.features = { ...fakeEngine.features, profiles: true };
  window.history.replaceState(null, "", "#/");
});
afterEach(() => {
  fakeEngine.features = { ...fakeEngine.features, profiles: false };
  if (vi.isFakeTimers()) act(() => { vi.runOnlyPendingTimers(); });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

for (const language of ["en", "ar"] as const) {
  describe(`the switch overlay (${language})`, () => {
    beforeEach(() => {
      localStorage.setItem(settingsKeyFor(""), JSON.stringify({ language }));
    });

    it("puts the whole app under it out of reach, and the focus on its words", async () => {
      windowIs(false);
      const work = createProfile("Work");
      render(<Root />);
      await screen.findByTestId("sidebar");
      expect(tabbable(document.body).length).toBeGreaterThan(5);

      act(() => announceSwitch(work.id));
      const splash = screen.getByTestId("profile-switch-splash");
      expect(outsideOverlay()).toEqual([]);
      expect(splash.contains(document.activeElement)).toBe(true);
      // The tab where the person chose it says what it says today.
      expect(splash).toHaveTextContent(WORDS[language].opening);
      expect(splash.querySelector("bdi")).toBeNull();
    }, 20_000);

    it("lets go of the page once it lifts: nothing left inert, the focus at the page's start", () => {
      pendingIn("Work");
      vi.useFakeTimers({ toFake: ["setTimeout"] });
      renderApp(<LockScreenProvider><Page /><ProfileSwitchSplash /></LockScreenProvider>, { language });
      const splash = screen.getByTestId("profile-switch-splash");
      expect(outsideOverlay()).toEqual([]);
      expect(screen.getByRole("button", { name: "New chat" }).closest("[inert]")).not.toBeNull();
      expect(splash.contains(document.activeElement)).toBe(true);

      act(() => { vi.advanceTimersByTime(300); });
      act(() => { vi.advanceTimersByTime(200); });
      expect(screen.queryByTestId("profile-switch-splash")).not.toBeInTheDocument();
      expect(document.querySelector("[inert]")).toBeNull();
      expect(document.activeElement).toBe(screen.getByTestId("page-main"));
    });

    it("leaves nothing inert when it goes away mid-switch", () => {
      pendingIn("Work");
      vi.useFakeTimers({ toFake: ["setTimeout"] });
      const { unmount } = renderApp(<LockScreenProvider><Page /><ProfileSwitchSplash /></LockScreenProvider>, { language });
      expect(document.querySelector("[inert]")).not.toBeNull();
      unmount();
      expect(document.querySelector("[inert]")).toBeNull();
    });

    it("says in a tab that follows another tab's switch that the other tab made it, the name in its own <bdi>", () => {
      pendingIn("Work!", { elsewhere: true });
      renderApp(<LockScreenProvider><ProfileSwitchSplash /></LockScreenProvider>, { language });
      const splash = screen.getByTestId("profile-switch-splash");
      expect(splash).toHaveTextContent(WORDS[language].elsewhere("Work!"));
      expect(splash.querySelector("bdi")?.textContent).toBe("Work!");
    });
  });
}

describe("a tab that follows another tab's switch", () => {
  it("is told so from the moment it hears of it, before its reload", async () => {
    windowIs(false);
    const work = createProfile("Work");
    render(<Root />);
    await screen.findByTestId("sidebar");
    act(() => announceSwitch(work.id, { elsewhere: true }));
    expect(screen.getByTestId("profile-switch-splash")).toHaveTextContent(WORDS.en.elsewhere("Work"));
    expect(JSON.parse(sessionStorage.getItem("ghostly_switching")!)).toMatchObject({ id: work.id, elsewhere: true });
    expect(outsideOverlay()).toEqual([]);
  }, 20_000);
});
