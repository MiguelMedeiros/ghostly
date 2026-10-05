import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Home } from "../../pages/Home";
import { renderApp } from "../render";
import { LANGUAGES, lookup } from "../i18n/locales";

// covers: app.home

/*
 * Ghostly has no disappearing messages: a chat's history stays on the person's devices until they delete it. The home
 * screen says that, as the website does ("Everything stays yours, on your devices"), and never that messages disappear.
 */

describe("the home screen's promise", () => {
  it("says messages stay on the person's devices, not that they disappear", () => {
    renderApp(<Home />);
    expect(screen.getByText("Your messages stay on your devices")).toBeTruthy();
    expect(screen.getByText("Private, peer-to-peer messaging.")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/disappear|ephemeral/i);
  });

  it.each(LANGUAGES)("%s has no ephemeral claim on the home screen or in the tagline", (language) => {
    expect(lookup(language, "home.features.ephemeral")).toBeUndefined();
    expect(lookup(language, "home.features.onDevice")?.trim()).toBeTruthy();
  });

  it("English never calls Ghostly ephemeral in its home or app strings", () => {
    for (const key of ["home.description", "home.features.onDevice", "app.tagline"]) expect(lookup("en", key)).not.toMatch(/ephemeral|disappear/i);
  });
});
