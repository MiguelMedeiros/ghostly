import { act, screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { MOBILE_QUERY } from "../../hooks/useIsMobile";
import { renameProfile } from "../../lib/profiles";
import type { Language } from "../../lib/settings";
import { Settings } from "../../pages/Settings";
import { renderApp } from "../render";

// covers: app.mobile-layout

// A phone has no account bar and Profile has no tab: Settings' Profile section is the way there.

/** The window as wide as a phone (below 768px) or not: `useIsMobile` asks `matchMedia`. */
function windowIs(phone: boolean) {
  const matchMedia = window.matchMedia.bind(window);
  vi.spyOn(window, "matchMedia").mockImplementation((query: string) =>
    query === MOBILE_QUERY ? ({ ...matchMedia(query), matches: phone, addEventListener: () => {}, removeEventListener: () => {} } as MediaQueryList) : matchMedia(query));
}

function renderSettings(language?: Language) {
  return renderApp(
    <LockScreenProvider>
      <UpdateProvider>
        <Routes>
          <Route path="/settings" element={<Settings />} />
          <Route path="/profile" element={<p>Profile page</p>} />
        </Routes>
      </UpdateProvider>
    </LockScreenProvider>,
    { route: "/settings", language },
  );
}

afterEach(() => vi.restoreAllMocks());

describe("Settings on a phone", () => {
  it("opens the active profile's page from the top of the Profile section", async () => {
    windowIs(true);
    renameProfile("", "Work");
    const { user } = renderSettings();

    const link = screen.getByTestId("settings-profile-link");
    expect(link).toHaveTextContent("Work");
    expect(link).toHaveTextContent("Name, picture, backups and other profiles");
    // First in the section, above the default nickname.
    expect(link.parentElement?.firstElementChild).toBe(link);
    expect(link.closest("section")).toContainElement(screen.getByLabelText("Default Nickname"));

    await user.click(link);
    expect(screen.getByText("Profile page")).toBeInTheDocument();
  });

  it("shows the profile's picture once it has one, its initial before", () => {
    windowIs(true);
    renameProfile("", "Work");
    const { engine } = renderSettings();
    const link = screen.getByTestId("settings-profile-link");
    expect(link.querySelector("img")).toBeNull();
    expect(link).toHaveTextContent(/^W/);

    act(() => engine.setState({ settings: { avatar: "data:image/jpeg;base64,AAAA" } }));
    expect(link.querySelector("img")).toHaveAttribute("src", "data:image/jpeg;base64,AAAA");
  });

  it("speaks the app's language", () => {
    windowIs(true);
    renderSettings("pt");
    expect(screen.getByTestId("settings-profile-link")).toHaveTextContent("Nome, foto, backups e outros perfis");
  });
});

describe("Settings on a wide screen", () => {
  it("leaves the way to Profile to the account bar", () => {
    windowIs(false);
    renderSettings();
    expect(screen.queryByTestId("settings-profile-link")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Default Nickname")).toBeInTheDocument();
  });
});
