import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { PublicProfileView } from "@ghostly/browser/shared/types";
import { IdentityActivity } from "../../components/identities/IdentityActivity";
import { PublicProfileDetails } from "../../components/identities/PublicProfileDetails";
import { renderApp } from "../render";

// covers: proofs.public-profile, app.i18n

/**
 * A public profile's name, handle and bio are the account's own words, in whatever script it wrote them. In Arabic
 * each keeps its own direction (a <bdi>, or dir="auto"), or a Latin bio "Ghosts and relays!" showed as
 * "!Ghosts and relays" and a handle "alice!" as "!alice", on a contact's card back and in their activity.
 */
const now = () => Math.floor(Date.now() / 1000);
const KEY = "o4dksfbqk85ogzdb5osziw6befigbuxmuxkuxq8434q89uj56uyy";
const profile: PublicProfileView = { found: true, name: "alice!", handle: "@alice!", about: "Ghosts and relays!", hosts: ["nexus.pubky.app"], fetchedAt: now() - 60 };

/** The element showing exactly this text is laid out in its own direction: a <bdi>, or dir="auto". */
const ownDirection = (root: HTMLElement, text: string) => {
  const shown = within(root).getByText(text);
  return shown.tagName === "BDI" || shown.getAttribute("dir") === "auto";
};

describe("in Arabic, a contact's public profile", () => {
  it.each(["back", "panel"] as const)("keeps the name, handle and bio in their own direction (%s)", (tone) => {
    renderApp(<PublicProfileDetails provider="pubky" profile={profile} tone={tone} testId="pp" />, { language: "ar" });
    const shown = screen.getByTestId("pp");
    for (const text of [profile.name!, profile.handle!, profile.about!]) expect(ownDirection(shown, text), text).toBe(true);
  });

  it("keeps them in their own direction in the contact's activity", () => {
    const { engine } = renderApp(<IdentityActivity provider="pubky" subject={KEY} profile={profile} links={[]} />, { language: "ar" });
    engine.on("loadPublicPosts", () => ({ posts: [], more: false, hosts: [], fetchedAt: now() }));
    engine.on("loadPublicGraph", () => null);
    const shown = screen.getByTestId("contact-activity");
    for (const text of [profile.name!, profile.handle!, profile.about!]) expect(ownDirection(shown, text), text).toBe(true);
  });
});
