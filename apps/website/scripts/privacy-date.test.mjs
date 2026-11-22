import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The "Last updated" date of the privacy policy moves with its text. app/privacy/updated.ts keeps the dates beside
 * PRIVACY_TEXT_SHA, the SHA-256 of app/privacy/page.tsx as it was when they were set (whitespace runs folded to one
 * space, so a reflow of the lines changes nothing). Any other edit of page.tsx fails here until the editor bumps the
 * date and the hash together; the failure prints the new hash. The dates are not in page.tsx, so they are outside the
 * hash. Only the source is read: CI checks out one commit, so there is no git history to compare with.
 */

const read = (file) => readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), "utf8");

/** What PRIVACY_TEXT_SHA fingerprints: page.tsx with whitespace folded. */
function pageSha() {
  return createHash("sha256").update(read("app/privacy/page.tsx").replace(/\s+/g, " ").trim()).digest("hex");
}

function constant(source, name) {
  const value = source.match(new RegExp(`export const ${name} = "([^"]*)";`))?.[1];
  assert.ok(value, `app/privacy/updated.ts exports ${name} as a string literal`);
  return value;
}

/** "November 3, 2026" as a UTC date, or a failed assertion. */
function day(text, name) {
  const at = /^(January|February|March|April|May|June|July|August|September|October|November|December) ([1-9]|[12]\d|3[01]), (\d{4})$/.exec(text);
  assert.ok(at, `${name} reads like "November 3, 2026", not "${text}"`);
  return Date.UTC(Number(at[3]), new Date(`${at[1]} 1, 2000`).getMonth(), Number(at[2]));
}

test("the privacy policy's date moves with its text", () => {
  const updated = read("app/privacy/updated.ts");
  const general = constant(updated, "LAST_UPDATED");
  const apps = constant(updated, "LAST_UPDATED_APPS");
  const sha = pageSha();
  assert.equal(
    constant(updated, "PRIVACY_TEXT_SHA"),
    sha,
    `app/privacy/page.tsx changed since its "Last updated" date (${apps}) was set. If what the page says changed, set ` +
      `LAST_UPDATED_APPS in app/privacy/updated.ts to the day of the change, and LAST_UPDATED too unless only an ` +
      `{apps && ...} item changed. Then set PRIVACY_TEXT_SHA there to "${sha}" (that alone when only code changed, ` +
      `not a word the reader sees).`,
  );
  // With Apps released the page shows LAST_UPDATED_APPS, so it dates every line, the ones before Apps too.
  assert.ok(day(apps, "LAST_UPDATED_APPS") >= day(general, "LAST_UPDATED"), `LAST_UPDATED_APPS (${apps}) is not before LAST_UPDATED (${general})`);
});
