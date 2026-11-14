import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { Profile } from "../../pages/Profile";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";
// covers: profiles.create

// Cancel unmounted the form with the focus in it: the focus fell to the page and the next Tab started from the top.
beforeEach(() => { fakeEngine.features = { ...fakeEngine.features, profiles: true }; });
afterEach(() => { fakeEngine.features = { ...fakeEngine.features, profiles: false }; });

describe("New profile, Cancel by the keyboard", () => {
  it("gives the focus back to New profile", async () => {
    const { user } = renderApp(<Profile />);
    screen.getByTestId("profile-new").focus();
    await user.keyboard("{Enter}");
    expect(screen.getByTestId("profile-new-name")).toHaveFocus();
    // Create is disabled while the name is empty: the next Tab is Cancel.
    await user.tab();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(screen.queryByTestId("profile-new-name")).toBeNull();
    await waitFor(() => expect(screen.getByTestId("profile-new")).toHaveFocus());
  });
});
