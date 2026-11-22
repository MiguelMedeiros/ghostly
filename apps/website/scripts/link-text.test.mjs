import { test } from "node:test";
import assert from "node:assert/strict";
import { linkText } from "../lib/linkText.ts";

// An app page (components/apps/AppPage.tsx) shows an app's Source and Support links as words. Those come from the
// publisher's manifest or the store's listing, and the browser goes to the host the URL parses to: the words name
// that host, never the text as written. isAppUrl (lib/store-core/appBundle.ts) takes these: https, parses, no user.

test("a link reads as it was written when that is where it goes", () => {
  assert.equal(linkText("https://github.com/MiguelMedeiros/ghostly"), "github.com/MiguelMedeiros/ghostly");
  assert.equal(linkText("https://example.com"), "example.com");
  assert.equal(linkText("https://example.com/"), "example.com");
  assert.equal(linkText("https://example.com:8443/a?b=c#d"), "example.com:8443/a?b=c#d");
});

test("a link names the host it goes to, not one its text spells", () => {
  for (const slash of ["∕", "⁄"]) {
    const href = `https://github.com${slash}MiguelMedeiros${slash}ghostly.attacker.dev/`;
    const text = linkText(href);
    assert.equal(text.split("/")[0], new URL(href).host);
    assert.ok(text.split("/")[0].endsWith(".attacker.dev"), text);
    assert.doesNotMatch(text, /^github\.com/);
  }
  const dot = linkText("https://github。com∕x.attacker.dev/");
  assert.ok(dot.startsWith("github.xn--"), dot);
  assert.equal(linkText("https://GitHub.COM/x"), "github.com/x");
  assert.equal(linkText("https://bücher.example/"), "xn--bcher-kva.example");
});
