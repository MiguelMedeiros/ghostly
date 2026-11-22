import { describe, expect, it } from "vitest";
import { problemLine, problemText, relayCause } from "../../lib/problemText";
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
    ["a relay that did not answer a moment ago", "Could not publish discovery: Publish failed on every relay: Error: https://a.test did not answer a moment ago; retry shortly", { kind: "wait" }],
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

  it("says a Reconnect that timed out as a wait in the language, its English behind the ⓘ (the app keeps dialling)", () => {
    const timedOut = "Timed out connecting to the peer";
    expect(problemText(timedOut, english, "connect")).toEqual({ tone: "wait", title: "Couldn't connect", next: "Trying again…", detail: timedOut });
    expect(problemText(new Error(timedOut), pt, "connect")).toEqual({ tone: "wait", title: pt("errors.problem.connectFailed"), next: pt("errors.problem.retrying"), detail: timedOut });
  });

  it("says a dial that found no transport in common in the language, with what to do, its English behind the ⓘ", () => {
    const none = "No transport both apps allow is available yet";
    expect(problemText(none, english, "connect")).toEqual({ tone: "error", title: "No way to connect in common", next: "Allow another transport, or turn Fallback on.", detail: none });
    for (const raw of [none, "No permitted transport could connect", "The peer closed this connection. Check that both transport preferences allow a common transport, then reconnect.", "Your contact needs an updated app to negotiate a transport change."]) {
      const said = problemText(raw, pt, "connect");
      expect(said.title, raw).not.toBe(raw);
      expect(said.next, raw).toBeDefined();
      expect(said.detail, raw).toBe(raw);
    }
  });

  it("says a known error in the language, whole, with no English beside it", () => {
    expect(problemText("Ghostly is starting…", english)).toEqual({ tone: "error", title: "Ghostly is starting…" });
    expect(problemText(new Error("Ghostly is starting…"), pt)).toEqual({ tone: "error", title: pt("errors.app.starting") });
  });

  it("says a call cut by the extension's peer going away in the tab's words, with what may have happened and what to do", () => {
    // An extension tab whose peer went away mid-call (an offscreen restart, Clear all data, a profile switch elsewhere):
    // the engine's word "peer" is no word of the tab's, and the old peer may have done it before it went.
    expect(problemText("Lost the Ghostly peer", english)).toEqual({
      tone: "error", title: "This tab lost Ghostly before this was done", next: "It may be done already. Check once Ghostly is back, then try again.",
    });
    expect(problemText(new Error("Lost the Ghostly peer"), pt)).toEqual({ tone: "error", title: pt("errors.app.lostPeer"), next: pt("errors.app.lostPeerNext") });
    for (const language of LANGUAGES) {
      const t = translateWith(LOCALES[language], language);
      expect(t("errors.app.lostPeer"), language).not.toMatch(/peer|pair|par\b|نظير|ピア|节点/i);
    }
  });

  it("never shows an unknown technical error as the line: a generic title, the English behind the ⓘ", () => {
    const fetchFailed = "TypeError: Failed to fetch (https://relay.example.test/abc)";
    expect(problemText(fetchFailed, english)).toEqual({ tone: "error", title: "Something went wrong", detail: "Failed to fetch (https://relay.example.test/abc)" });
    expect(problemText("Error: connect ECONNREFUSED 127.0.0.1:9; Error: connect ECONNREFUSED 127.0.0.1:10", pt, "connect")).toMatchObject({ tone: "error", title: "Não foi possível conectar" });
    expect(problemText("word ".repeat(25).trim(), english).title).toBe("Something went wrong");
    // A provider's code is no line a person reads (payment providers, 2026-10-07).
    for (const code of ["insufficient_balance", "INTERNAL: wallet not found", "402 Payment Required", "ERR_TIMEOUT"]) expect(problemText(code, english).title, code).toBe("Something went wrong");
    // One plain word is.
    expect(problemText("refused", english).title).toBe("refused");
  });

  it("keeps a short line a person can read as it came (the engine's own words, until a rule says it in the language)", () => {
    expect(problemText("The code changed", english)).toEqual({ tone: "error", title: "The code changed" });
    expect(problemText(new Error("Relay refused"), pt, "connect")).toEqual({ tone: "error", title: "Relay refused" });
  });

  it.each(LANGUAGES.filter((l) => l !== "en"))("says every kind in %s, not in English, and fills every value", (language) => {
    const t = translateWith(LOCALES[language], language);
    for (const text of [PHONE, "Could not read discovery: timeout", "Session receive queue full", "Session frame too large", "TypeError: Failed to fetch (https://a.test)", "Timed out connecting to the peer"]) {
      const said = problemText(text, t, "connect"), en = problemText(text, english, "connect");
      expect(said.title).not.toBe(en.title);
      expect(`${said.title} ${said.next ?? ""}`).not.toContain("{{");
    }
  });
});

describe("problemLine: a problem where only a line fits", () => {
  /** An identity check's reasons, 2026-10-07: each one a bare "Something went wrong" on the add dialog and the contact's card. */
  const SPECIFIC: [string, RegExp][] = [
    ["No Ghostly TXT record at _ghostly.example.com", /TXT record/],
    ["https://example.com/.well-known/ghostly.json was not found", /proof file was not found/],
    ["This signature was made by another key (0123ABCD), not the public key given.", /made by another key\. Not the public key you gave\./],
    ["That signature was made by SHA256:AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefg, not the key you entered (SHA256:x)", /made by another key\. Not the key you entered\./],
    ["GitHub: octo-cat does not list the key that signed (SHA256:AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefg)", /octo-cat doesn't list the key that signed/],
    ["Enter at least one relay address (https://…)", /at least one relay/],
    ["The TXT record at _ghostly.example.com names another Ghostly key: this proof was replaced or removed", /TXT record names another Ghostly key\. The record must hold this proof's value\./],
    // None of these is known: their words stay after the title.
    ["https://example.com/.well-known/nostr.json names another Nostr key for example.com", /names another Nostr key/],
    ["Key SHA256:AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefg is not allowed here", /is not allowed here/],
  ];

  it.each(SPECIFIC)("a reason with an underscore, a URL or a fingerprint is never a bare \"Something went wrong\": %s", (text, said) => {
    expect(problemLine(text, english)).not.toBe(english("errors.generic"));
    expect(problemLine(text, english)).toMatch(said);
    expect(problemLine(new Error(text), pt)).not.toBe(pt("errors.generic"));
  });

  it("a known reason is said in the language, its address behind the ⓘ where there is one", () => {
    expect(problemText("No Ghostly TXT record at _ghostly.example.com (DNS changes can take a few minutes)", english)).toEqual({
      tone: "error", title: "No Ghostly TXT record in the domain's DNS", next: "DNS changes can take a few minutes.", detail: "No Ghostly TXT record at _ghostly.example.com (DNS changes can take a few minutes)",
    });
    expect(problemLine("This signature was made by another key, not the public key given.", pt)).toBe(`${pt("errors.proof.otherKey")}. ${pt("errors.proof.otherKeyPgpNext")}`);
  });

  /** Add's refusals for an SSH key proof (packages/browser/src/proofs/providers/ssh.ts, core sshsig.ts): English in every language until 2026-11-15. */
  const SSH_REFUSALS: [string, string][] = [
    ["Paste your public key (the one line in ~/.ssh/id_ed25519.pub) or its SHA256: fingerprint", "That is not an SSH public key. Paste the one line in ~/.ssh/id_ed25519.pub, or its SHA256: fingerprint."],
    ['Unsupported SSH key type "ssh-dss"', "This kind of SSH key can't be used. Use an Ed25519, ECDSA or RSA key."],
    ["Unsupported SSH key type", "This kind of SSH key can't be used. Use an Ed25519, ECDSA or RSA key."],
    ["RSA keys must be 2048-16384 bits", "This RSA key is too small or too large. Use an RSA key of 2048 to 16384 bits, or an Ed25519 key."],
    ["Enter a GitHub username", "Enter a GitHub username"],
    ["Enter a GitLab username", "Enter a GitLab username"],
    ["Paste the whole signature, from -----BEGIN SSH SIGNATURE----- to -----END SSH SIGNATURE-----", "That is not the whole signature. Paste it from -----BEGIN SSH SIGNATURE----- to -----END SSH SIGNATURE-----."],
    ['That signature is for "git", not "ghostly": run the command with -n ghostly', "This signature was made for \"git\", not for Ghostly. Run the command again with -n ghostly."],
    ["The signature is not over this statement: copy the command again and sign exactly what it shows", "The signature is not over this statement. Copy the command again and sign exactly what it shows."],
  ];

  it.each(SSH_REFUSALS)("an SSH key proof's refusal is said in the app's language, with what to do: %s", (text, line) => {
    expect(problemLine(new Error(text), english)).toBe(line);
    for (const language of LANGUAGES.filter(l => l !== "en")) {
      const t = translateWith(LOCALES[language], language);
      const said = problemLine(new Error(text), t);
      expect(said, language).not.toBe(line);
      expect(said, language).not.toContain(t("errors.generic"));
      expect(said, language).not.toContain("{{");
    }
  });

  it("an Iroh relay refused for plain http:// is the reason alone, with no \"Something went wrong\" in front", () => {
    const refused = new Error("Use an https:// relay address: http://relay.example.org/");
    expect(problemLine(refused, english)).toBe("Use an https:// relay address: http://relay.example.org/");
    expect(problemLine(refused, pt)).toBe(pt("errors.relays.useHttps", { address: "http://relay.example.org/" }));
    expect(problemLine(refused, pt)).not.toContain(pt("errors.generic"));
  });
});
