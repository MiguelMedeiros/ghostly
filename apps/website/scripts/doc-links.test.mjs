import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { missingDocLinks, privateRefs } from "./doc-links.mjs";

const repo = fileURLToPath(new URL("../../../", import.meta.url));

test("a published document's relative .md links each name a file of the repository", () => {
  const root = mkdtempSync(join(tmpdir(), "doc-links-"));
  mkdirSync(join(root, "docs", "wisps"), { recursive: true });
  writeFileSync(join(root, "docs", "wisps", "503-group-files.md"), "# WISP 503\n");
  writeFileSync(join(root, "docs", "PROTOCOL.md"), "# Protocol\n");
  const body = [
    "[here](503-group-files.md#sharing), [up](../PROTOCOL.md), [same page](#log), [out](https://example.org/x.md), [code](../../packages/core/src/invite.ts)",
    "[pasted from a change file](../../503-group-files.md) and [gone](404-nothing.md#part)",
    "`[text](url.md)` is how a link is written:",
    "```",
    "[label](example.md)",
    "```",
  ].join("\n");
  assert.deepEqual(missingDocLinks(body, "docs/wisps/400-chat.md", root), ["../../503-group-files.md", "404-nothing.md#part"]);
  assert.deepEqual(missingDocLinks("[up](wisps/503-group-files.md)", "docs/PROTOCOL.md", root), []);
});

test("another repository's issue with no owner, or under this one's owner, is found; this repository's and an upstream's are not", () => {
  const body = [
    "nothing reached it (other-repo#1), held for a day (tracker#2), and `OTHER-REPO#3` in code.",
    "See MiguelMedeiros/other-repo#4. Fixed in ghostly#5 and MiguelMedeiros/ghostly#6, upstream in owner/repo#7.",
    "A PKCS#8 key, a [section](400-chat.md#log) and #9 alone are no repository's issue.",
  ].join("\n");
  assert.deepEqual(privateRefs(body), ["other-repo#1", "tracker#2", "OTHER-REPO#3", "MiguelMedeiros/other-repo#4"]);
});

test("no document the site publishes, revision logs included, cites another repository's issue a reader may not open", () => {
  // What scripts/sync-references.mjs publishes: every WISP, its change files (the revision log), and the other docs.
  const wisps = join(repo, "docs/wisps");
  const files = [
    ...readdirSync(wisps).filter((name) => name.endsWith(".md")).map((name) => join(wisps, name)),
    ...readdirSync(join(wisps, "changes"), { recursive: true }).filter((name) => String(name).endsWith(".md")).map((name) => join(wisps, "changes", String(name))),
    join(repo, "docs/PROTOCOL.md"),
    join(repo, "docs/SDK.md"),
    join(repo, "docs/USDT-INTEGRATION.md"),
    join(repo, "docs/DHT-DELIVERY.md"),
  ];
  const found = files.flatMap((file) => privateRefs(readFileSync(file, "utf8")).map((ref) => `${file.slice(repo.length)}: ${ref}`));
  assert.deepEqual(found, []);
});
