import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { createProfile, listProfiles, PROFILE_NAME_MAX, registryKey, renameProfile } from "../../lib/profiles";
import { Profile } from "../../pages/Profile";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";
// covers: profiles.create

// A family emoji is 7 characters (4 people, 3 joiners) and 11 UTF-16 units: an input's maxLength of 32 kept two
// families and a half of the third ending on a joiner (agents#2311).
const family = "👨‍👩‍👧‍👦";
const codePoints = (s: string) => [...s].length;

beforeEach(() => { fakeEngine.features = { ...fakeEngine.features, profiles: true }; });
afterEach(() => { fakeEngine.features = { ...fakeEngine.features, profiles: false }; });

describe("the profile's name fields", () => {
  it("cut a pasted name between whole emoji, in New profile and in the profile's own name", async () => {
    const { user } = renderApp(<Profile />);
    await user.click(screen.getByTestId("profile-new"));
    const created = screen.getByTestId("profile-new-name");
    // Four families are 28 characters: they fit, and a fifth is left out whole.
    await user.paste(family.repeat(5));
    expect(created).toHaveValue(family.repeat(4));
    await user.clear(created);
    // 32 emoji of one character each fit (16 filled the field).
    await user.paste("🎉".repeat(40));
    expect(created).toHaveValue("🎉".repeat(PROFILE_NAME_MAX));

    const name = screen.getByTestId("profile-name");
    await user.clear(name);
    await user.paste(`Home ${family.repeat(4)}`);
    expect(name).toHaveValue(`Home ${family.repeat(3)}`);
    await user.type(name, "{Enter}");
    expect(listProfiles()[0].name).toBe(`Home ${family.repeat(3)}`);
  });

  it("take a typed emoji only while it fits, and never save a name ending on a joiner", async () => {
    const { user } = renderApp(<Profile />);
    const name = screen.getByTestId("profile-name");
    await user.clear(name);
    await user.type(name, "x".repeat(26));
    // A whole family inserted with no room for it is refused; single emoji go in up to the limit.
    await user.paste(family);
    expect(name).toHaveValue("x".repeat(26));
    await user.type(name, "🎉".repeat(10));
    expect(name).toHaveValue("x".repeat(26) + "🎉".repeat(6));
    // Typed a part at a time, a family fills the last room up to a joiner: the name is saved without it.
    await user.clear(name);
    await user.type(name, "x".repeat(26) + family);
    expect((name as HTMLInputElement).value.endsWith("\u200d")).toBe(true);
    await user.type(name, "{Enter}");
    expect(listProfiles()[0].name).toBe("x".repeat(26) + "👨‍👩‍👧");
  });

  it("take no name with nothing visible: New profile's Create stays off, and the registry refuses it", async () => {
    const { user } = renderApp(<Profile />);
    await user.click(screen.getByTestId("profile-new"));
    await user.paste("\u200b\u200b");
    expect(screen.getByTestId("profile-create")).toBeDisabled();
    expect(() => createProfile("\u200b \u2066\u2069")).toThrow("Give the profile a name");
    expect(() => renameProfile("", "\u200b\u200e")).toThrow("Give the profile a name");
    expect(listProfiles()).toHaveLength(1);
    // Hidden and direction-changing characters go from a name that shows; an emoji's joiners stay.
    renameProfile("", `Wo\u200brk\u202e ${family}`);
    expect(listProfiles()[0].name).toBe(`Work ${family}`);
  });

  it("are kept whole by the registry, which cuts a longer name between whole characters too", () => {
    localStorage.setItem(registryKey(), JSON.stringify({ version: 1, active: "", profiles: [{ id: "", name: "Personal", createdAt: 0 }] }));
    renameProfile("", `Work ${family.repeat(5)}`);
    const kept = listProfiles()[0].name;
    expect(kept).toBe(`Work ${family.repeat(3)}`);
    expect(codePoints(kept)).toBeLessThanOrEqual(PROFILE_NAME_MAX);
  });
});
