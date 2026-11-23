import { act, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Profile } from "../../pages/Profile";
import { renderApp } from "../render";
// covers: profiles.picture

// Remove picture went with the picture: the focus fell to the page and the next Tab started from the colours.
describe("Profile's Remove picture, by the keyboard", () => {
  it("gives the focus to Add picture, which takes its place", async () => {
    const { user, engine } = renderApp(<Profile />);
    act(() => engine.setState({ settings: { avatar: "data:image/jpeg;base64,AAAA" } }));
    engine.on("updateSettings", ({ settings }) => { engine.setState({ settings: { avatar: settings.avatar } }); });
    screen.getByTestId("profile-avatar-remove").focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByTestId("profile-avatar-remove")).toBeNull());
    const add = screen.getByTestId("profile-avatar-input");
    expect(add).toHaveAccessibleName("Add a picture");
    await waitFor(() => expect(add).toHaveFocus());
  });

  it("is as tall as the app's touch targets on a phone", () => {
    const { engine } = renderApp(<Profile />);
    act(() => engine.setState({ settings: { avatar: "data:image/jpeg;base64,AAAA" } }));
    expect(screen.getByTestId("profile-avatar-remove").className.split(/\s+/)).toContain("max-md:min-h-11");
  });
});
