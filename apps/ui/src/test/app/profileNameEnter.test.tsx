import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { listProfiles } from "../../lib/profiles";
import { Profile } from "../../pages/Profile";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";
// covers: profiles.create

beforeEach(() => { fakeEngine.features = { ...fakeEngine.features, profiles: true }; });
afterEach(() => { fakeEngine.features = { ...fakeEngine.features, profiles: false }; });

describe("the profile's name field", () => {
  it("saves on Enter with the focus kept in the field, and says the name was saved", async () => {
    const { user } = renderApp(<Profile />);
    const name = screen.getByTestId("profile-name");
    await user.clear(name);
    await user.type(name, "Work{Enter}");
    expect(listProfiles()[0].name).toBe("Work");
    // Enter used to blur the field: the focus fell to the page and nothing said the rename happened.
    expect(name).toHaveFocus();
    // A status line, there before it fills, so a screen reader hears it once.
    expect(screen.getByTestId("profile-name-saved")).toHaveAttribute("role", "status");
    expect(screen.getByTestId("profile-name-saved")).toHaveTextContent("Name saved");
    // Typing again takes the line away; Enter with nothing changed says nothing new.
    await user.type(name, "s");
    expect(screen.getByTestId("profile-name-saved")).toHaveTextContent("");
    await user.type(name, "{Backspace}{Enter}");
    expect(screen.getByTestId("profile-name-saved")).toHaveTextContent("");
    expect(name).toHaveFocus();
  });

  it("keeps the focus and says nothing on Enter with an empty name, which is not saved", async () => {
    const { user } = renderApp(<Profile />);
    const name = screen.getByTestId("profile-name");
    await user.clear(name);
    await user.type(name, "   {Enter}");
    expect(name).toHaveFocus();
    expect(listProfiles()[0].name).not.toBe("   ");
    expect(screen.getByTestId("profile-name-saved")).toHaveTextContent("");
  });

  it("shows the saved name again when the field is left empty, as the nickname field does", async () => {
    const { user } = renderApp(<Profile />);
    const name = screen.getByTestId("profile-name");
    const saved = listProfiles()[0].name;
    await user.clear(name);
    await user.type(name, "   ");
    await user.tab();
    // The name stays as it was: the field said nothing and showed an empty name until the page was opened again.
    expect(listProfiles()[0].name).toBe(saved);
    expect(name).toHaveValue(saved);
  });
});
