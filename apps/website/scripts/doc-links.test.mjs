import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { missingDocLinks } from "./doc-links.mjs";

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
