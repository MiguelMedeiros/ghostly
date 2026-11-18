import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { NostrContactView } from "@ghostly/browser/nostr/types";
import { NostrContactCard } from "../../components/nostr/NostrContactCard";
import { renderApp } from "../render";
import { now } from "./views";

// covers: nostr.social.profile, app.i18n

/*
 * A contact's Nostr website is an address, read left to right in every language. The engine keeps it as the URL's
 * href, so a bare host ends with "/": in Arabic that slash took the app's direction and the card read
 * "/https://alice.example". It keeps its own direction now, as the activity panel's website does.
 */

const view = (website: string): NostrContactView => ({
  subject: "npub1example",
  npub: "npub1example",
  profile: { fetchedAt: now(), relays: ["wss://relay.test"], stale: false, found: true, profile: { name: "Alice", website, hasPicture: false, eventAt: now() - 60, eventId: "e1" } },
});

describe("a contact's Nostr website", () => {
  it("reads left to right in Arabic, its address in a <bdi>", () => {
    renderApp(<NostrContactCard linkId="link-1" view={view("https://alice.example/")} name="Alice" />, { language: "ar" });
    const link = screen.getByRole("link", { name: /alice\.example/ });
    expect(link).toHaveAttribute("dir", "ltr");
    expect(link).toHaveAttribute("href", "https://alice.example/");
    expect(link.firstElementChild?.tagName).toBe("BDI");
    expect(link).toHaveTextContent("https://alice.example/");
  });
});
