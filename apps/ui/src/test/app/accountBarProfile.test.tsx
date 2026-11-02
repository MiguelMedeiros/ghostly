import { act, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AccountBar } from "../../components/AccountBar";
import { currentProfile, renameProfile } from "../../lib/profiles";
import { shownInName } from "../labelInName";
import { renderApp } from "../render";

/** The place's label (its text also holds the picture's initial). */
const label = () => screen.getByTestId("account-profile").querySelector(".account-label");

// covers: profiles.switch, app.responsive

/** The Profile place in the account bar is named after the profile it stands for, and follows it. */
describe("the account bar's Profile place", () => {
  it("wears the current profile's name, in full in its tooltip", () => {
    renderApp(<AccountBar />);
    const profile = currentProfile();
    expect(profile.name).toBe("Personal");
    expect(label()).toHaveTextContent(/^Personal$/);
    expect(screen.getByTestId("account-profile")).toHaveAttribute("title", "Profile: Personal");
    expect(screen.getByTestId("account-profile")).toHaveAccessibleName(/^Profile: Personal, /);
  });

  it("is named with what it shows: the picture's initial is drawn, not text beside the name", () => {
    renderApp(<AccountBar />);
    const place = screen.getByTestId("account-profile");
    expect(place).toHaveAccessibleName(shownInName(place));
  });

  it.each([["ja", /, (オンライン|オフライン)$/], ["ar", /, (متصل|غير متصل)$/]] as const)("says Online or Offline in the app's language (%s)", (language, state) => {
    renderApp(<AccountBar />, { language });
    const name = screen.getByTestId("account-profile").getAttribute("aria-label");
    expect(name).toMatch(state);
    expect(name).not.toMatch(/Online|Offline/);
  });

  it("follows a rename at once", () => {
    renderApp(<AccountBar />);
    act(() => renameProfile(currentProfile().id, "Diary of a ghost"));
    expect(label()).toHaveTextContent(/^Diary of a ghost$/);
    expect(screen.getByTestId("account-profile")).toHaveAttribute("title", "Profile: Diary of a ghost");
    act(() => renameProfile(currentProfile().id, "Personal"));
  });

  // A switch restarts the app (lib/profiles.ts): the place shows the new profile's name once the new page draws,
  // which e2e/web/profile-switcher.spec.ts checks.
});
