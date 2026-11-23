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

test("a reference to the private tracker is found, a public pull request's is not", () => {
  const body = [
    "nothing reached it (ghostly-agents#1), held for a day (agents#2), and `GHOSTLY-AGENTS#3` in code.",
    "See MiguelMedeiros/ghostly-agents#4. Fixed in ghostly#5 and MiguelMedeiros/ghostly#6; user-agents#7 and my_agents#8 are not ours.",
  ].join("\n");
  assert.deepEqual(privateRefs(body), ["ghostly-agents#1", "agents#2", "GHOSTLY-AGENTS#3", "ghostly-agents#4"]);
});

test("no document the site publishes, revision logs included, cites the private tracker", () => {
  // What scripts/sync-references.mjs publishes: every WISP, its change files (the revision log), and the other docs.
  const wisps = join(repo, "docs/wisps");
  const files = [
    ...readdirSync(wisps).filter((name) => name.endsWith(".md")).map((name) => join(wisps, name)),
    ...readdirSync(join(wisps, "changes"), { recursive: true }).filter((name) => String(name).endsWith(".md")).map((name) => join(wisps, "changes", String(name))),
    ...["PROTOCOL.md", "SDK.md", "USDT-INTEGRATION.md", "DHT-DELIVERY.md"].map((name) => join(repo, "docs", name)),
  ];
  const found = files.flatMap((file) => privateRefs(readFileSync(file, "utf8")).map((ref) => `${file.slice(repo.length)}: ${ref}`));
  assert.deepEqual(found, []);
});
