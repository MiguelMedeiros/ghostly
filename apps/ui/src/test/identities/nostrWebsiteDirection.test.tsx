import { act, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { NostrContactView } from "@ghostly/browser/nostr/types";
import { NostrContactCard } from "../../components/nostr/NostrContactCard";
import { fakeEngine } from "../fakeEngine";
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

describe("a contact's Nostr relays", () => {
  // The relays asked and the ones the profile came from, as the language lists them, each isolated: not "a, b".
  it.each([
    ["ja", "読み込むとリレー (⁨relay.one⁩、⁨relay.two⁩) に問い合わせ", "⁨relay.one⁩、⁨relay.two⁩ から "],
    ["ar", "التحميل يسأل مرحّلاتك (⁨relay.one⁩ و⁨relay.two⁩)،", "من ⁨relay.one⁩ و⁨relay.two⁩ "],
  ] as const)("in %s, are listed the way the language lists them, each name on its own", (language, asked, from) => {
    const relays = ["wss://relay.one", "wss://relay.two"];
    const card = view("https://alice.example/");
    renderApp(<NostrContactCard linkId="link-1" view={{ ...card, profile: { ...card.profile!, relays } }} name="Alice" compact />, { language });
    act(() => fakeEngine.update({ nostr: { own: [], settings: { relays, autoLoadProfiles: false, publish: false } } }));
    expect(screen.getByTestId("nostr-contact-note").textContent).toContain(asked);
    expect(screen.getByTestId("nostr-profile-source").textContent).toContain(from);
  });
});
