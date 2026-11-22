import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { listProfiles } from "../../lib/profiles";
import { Profile } from "../../pages/Profile";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";
// covers: profiles.create

// The switch to a new profile waits 80 ms before it reloads: a second submit in that moment made a second
// profile of the same name, and its own timer chose that one.
let reload: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  fakeEngine.features = { ...fakeEngine.features, profiles: true };
  reload = vi.spyOn(window.location, "reload").mockImplementation(() => {});
});
afterEach(() => {
  fakeEngine.features = { ...fakeEngine.features, profiles: false };
  vi.restoreAllMocks();
});

const named = (name: string) => listProfiles().filter((entry) => entry.name === name).length;

describe("New profile, submitted again before the page reloads", () => {
  it.each([
    ["Enter twice", "{Enter}{Enter}", false],
    ["Enter, then a click on Create", "{Enter}", true],
  ])("makes one profile: %s", async (_, keys, click) => {
    const { user } = renderApp(<Profile />);
    await user.click(screen.getByTestId("profile-new"));
    await user.type(screen.getByTestId("profile-new-name"), `Work${keys}`);
    if (click) await user.click(screen.getByTestId("profile-create"));
    await waitFor(() => expect(reload).toHaveBeenCalled());
    await new Promise((done) => setTimeout(done, 200));
    expect(named("Work")).toBe(1);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("makes one profile on a double click on Create", async () => {
    const { user } = renderApp(<Profile />);
    await user.click(screen.getByTestId("profile-new"));
    await user.type(screen.getByTestId("profile-new-name"), "Work");
    await user.dblClick(screen.getByTestId("profile-create"));
    await waitFor(() => expect(reload).toHaveBeenCalled());
    await new Promise((done) => setTimeout(done, 200));
    expect(named("Work")).toBe(1);
    expect(reload).toHaveBeenCalledOnce();
  });
});
