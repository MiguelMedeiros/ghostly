import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { PublicGraphView, PublicProfileView } from "@ghostly/browser/shared/types";
import { IdentityActivity } from "../../components/identities/IdentityActivity";
import { PublicProfileDetails } from "../../components/identities/PublicProfileDetails";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: proofs.public-profile, proofs.public-activity.graph, app.i18n

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

/**
 * The "People you know" chips draw an arrow before a contact's name: "→ Ana" (follows Ana), "← Ana" (Ana follows
 * them). In Arabic the arrow sits to the right of the name, so unmirrored "follows Ana" pointed away from Ana and
 * read as "followed by". The arrow is mirrored there, as the app's other arrows are; "⇄" is the same either way.
 */
describe("in Arabic, the people-you-know chips", () => {
  it("mirror the follow arrow, which keeps pointing from the follower to the one followed", async () => {
    const graph: PublicGraphView = {
      compared: true, followsYou: false, youFollow: false, hosts: [], fetchedAt: now(),
      contacts: [{ linkId: "L-a", follows: true, followedBy: false }, { linkId: "L-b", follows: false, followedBy: true }, { linkId: "L-c", follows: true, followedBy: true }],
    };
    const links = ["L-a", "L-b", "L-c"].map(id => linkView({ id, peerPubKeyZ32: `${id}-key` }));
    const { engine } = renderApp(<IdentityActivity provider="pubky" subject={KEY} profile={profile} links={links} />, { language: "ar" });
    engine.on("loadPublicPosts", () => ({ posts: [], more: false, hosts: [], fetchedAt: now() }));
    engine.on("loadPublicGraph", () => graph);
    await screen.findByTestId("contact-activity-chips");
    expect(document.documentElement.dir).toBe("rtl");
    const arrow = (link: string) => {
      const chip = screen.getAllByTestId("contact-activity-contact").find(c => c.dataset.link === link)!;
      return chip.querySelector("span[aria-hidden='true']") as HTMLElement;
    };
    for (const [link, glyph] of [["L-a", "→"], ["L-b", "←"], ["L-c", "⇄"]] as const) {
      expect(arrow(link).textContent, link).toBe(glyph);
      // A transform needs a box: an inline span ignores it.
      expect(arrow(link).classList.contains("rtl:-scale-x-100"), link).toBe(true);
      expect(arrow(link).classList.contains("inline-block"), link).toBe(true);
    }
  });
});
