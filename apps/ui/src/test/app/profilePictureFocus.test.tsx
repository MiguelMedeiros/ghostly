import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { Profile } from "../../pages/Profile";
import { renderApp } from "../render";

describe("Profile's picture button", () => {
  /**
   * With no picture the badge is filled with the profile's colour, the accent itself: a 2px accent ring on it only
   * made the same disc 2px wider, nothing to see where the keyboard was. A gap of the page's colour sets it apart.
   */
  it("draws its keyboard focus ring apart from the badge", () => {
    renderApp(<Profile />);
    const label = screen.getByTestId("profile-avatar-input").closest("label")!;
    expect(label.className.split(/\s+/)).toEqual(expect.arrayContaining(["focus-within:ring-2", "focus-within:ring-accent", "focus-within:ring-offset-2", "focus-within:ring-offset-chat-bg"]));
  });
});
