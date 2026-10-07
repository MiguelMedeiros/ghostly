import { describe, expect, it } from "vitest";
import { problemText, relayCause } from "../../lib/problemText";
import { english } from "../../lib/english";
import { translateWith } from "../../locales/translate";
import { LANGUAGES, LOCALES } from "./locales";

// covers: app.i18n

/*
 * An error as a notice says it (lib/problemText.ts): a few words in the app's language, and the engine's English
 * (relay addresses, error names) only as the detail behind the ⓘ. A retry the app makes by itself is a wait, not red.
 */

const pt = translateWith(LOCALES.pt, "pt");
/** Miguel's phone, 2026-10-07: the group member panel showed this in red, in English, in every language. */
const PHONE = "Could not publish discovery: Publish failed on every relay: DiscoveryBudgetError: Discovery request budget reached; retry shortly; Error: https://pkarr.pubky.app is left alone after failing; asked again in 52 s";

describe("relayCause: what a relay error comes down to", () => {
  it.each<[string, string, ReturnType<typeof relayCause>]>([
    ["every relay held back or left alone, with the soonest retry", PHONE, { kind: "wait", retryInS: 52 }],
    ["held back on every relay", "Could not publish discovery: Publish held back on every relay: DiscoveryBudgetError: Discovery request budget reached; retry shortly", { kind: "wait" }],
    ["a relay cooling down", "Could not publish discovery: Publish failed on every relay: Error: Discovery relay is cooling down; retry shortly", { kind: "wait" }],
    ["connection details held back, retried in a minute", "Could not publish connection details: Publish held back on every relay: DiscoveryBudgetError: Discovery request budget reached; retry shortly. Retrying in 60 s.", { kind: "wait", retryInS: 60 }],
    ["a relay failing now beside one held back", "Could not publish discovery: Publish failed on every relay: DiscoveryBudgetError: Discovery request budget reached; retry shortly; Error: https://a.test responded 500", { kind: "unreachable" }],
    ["a read that timed out", "Could not read discovery: timeout", { kind: "unreachable" }],
    ["every relay failing, with a breaker's retry", "Could not publish connection details: Publish failed on every relay: Error: https://a.test responded 500. Retrying in 60 s.", { kind: "unreachable", retryInS: 60 }],
    ["no relay reachable", "Could not read DHT delivery: No Pkarr relay reachable", { kind: "unreachable" }],
  ])("%s", (_, text, want) => expect(relayCause(text)).toEqual(want));

  it("is null for anything that is not about the relays", () => {
    expect(relayCause("Session receive queue full")).toBeNull();
    expect(relayCause("TypeError: Failed to fetch")).toBeNull();
  });
});

describe("problemText: an error in a few words, its English behind the ⓘ", () => {
  it("says the relays wait, with the soonest retry, never red, and keeps the English as the detail", () => {
    expect(problemText(PHONE, english)).toEqual({ tone: "wait", title: "Waiting for the relays", next: "Retrying in 52 s", detail: PHONE });
    expect(problemText(PHONE, pt)).toMatchObject({ tone: "wait", title: "Aguardando os relays", next: "Nova tentativa em 52 s" });
  });

  it("says relays failing now in red, with what to check", () => {
    expect(problemText("Could not read discovery: timeout", english)).toEqual({ tone: "error", title: "Can't reach the relays", next: "Trying again. Check your connection.", detail: "Could not read discovery: timeout" });
  });

  it("tells a session dropped (dialled again) from a frame that breaks the protocol (packages/core pairedSession.ts)", () => {
    expect(problemText("Session receive queue full", english, "connect")).toMatchObject({ tone: "wait", title: "Connection dropped", next: "Trying again…" });
    expect(problemText("Session frame too large", english, "connect")).toEqual({ tone: "error", title: "Couldn't connect", detail: "Session frame too large" });
  });

  it("says a known error in the language, whole, with no English beside it", () => {
    expect(problemText("Lost the Ghostly peer", english)).toEqual({ tone: "error", title: "Lost the Ghostly peer" });
    expect(problemText(new Error("Lost the Ghostly peer"), pt)).toEqual({ tone: "error", title: pt("errors.app.lostPeer") });
  });

  it("never shows an unknown technical error as the line: a generic title, the English behind the ⓘ", () => {
    const fetchFailed = "TypeError: Failed to fetch (https://relay.example.test/abc)";
    expect(problemText(fetchFailed, english)).toEqual({ tone: "error", title: "Something went wrong", detail: "Failed to fetch (https://relay.example.test/abc)" });
    expect(problemText("Error: connect ECONNREFUSED 127.0.0.1:9; Error: connect ECONNREFUSED 127.0.0.1:10", pt, "connect")).toMatchObject({ tone: "error", title: "Não foi possível conectar" });
    expect(problemText("A".repeat(81), english).title).toBe("Something went wrong");
  });

  it("keeps a short line a person can read as it came (the engine's own words, until a rule says it in the language)", () => {
    expect(problemText("The code changed", english)).toEqual({ tone: "error", title: "The code changed" });
    expect(problemText(new Error("Relay refused"), pt, "connect")).toEqual({ tone: "error", title: "Relay refused" });
  });

  it.each(LANGUAGES.filter((l) => l !== "en"))("says every kind in %s, not in English, and fills every value", (language) => {
    const t = translateWith(LOCALES[language], language);
    for (const text of [PHONE, "Could not read discovery: timeout", "Session receive queue full", "Session frame too large", "TypeError: Failed to fetch (https://a.test)"]) {
      const said = problemText(text, t, "connect"), en = problemText(text, english, "connect");
      expect(said.title).not.toBe(en.title);
      expect(`${said.title} ${said.next ?? ""}`).not.toContain("{{");
    }
  });
});
