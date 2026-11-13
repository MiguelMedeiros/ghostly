import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { developers } from "../content/developers.ts";

// /developers' "Where it runs" table (content/developers.ts) against where Apps (WISP 1200 · Per client) runs: in every
// build that has the feature on (packages/browser/src/shared/features.ts), on the web and on Desktop where the app's one
// rule lets it (apps/ui/src/lib/apps/flag.ts `appsPlatform`: not Desktop on Windows), never in the extension or the CLI,
// which run none.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const read = (file) => readFileSync(resolve(root, file), "utf8");
const enabled = /export const APPS_ENABLED: boolean = (true|false)/.exec(read("packages/browser/src/shared/features.ts"))?.[1];
const { clients, rows } = developers.availability;

test("the table has a row for Apps while the app has them on, with the clients that run them", () => {
  assert.ok(enabled, "APPS_ENABLED is in packages/browser/src/shared/features.ts");
  const row = rows.find((r) => /^Apps\b/.test(r.name));
  if (enabled === "false") return assert.equal(row, undefined);
  assert.ok(row, `no row for Apps among: ${rows.map((r) => r.name).join("; ")}`);
  const cell = (client) => row.cells[clients.indexOf(client)];
  assert.equal(cell("Web app"), "available");
  assert.equal(cell("Desktop"), "available");
  assert.equal(cell("Extension"), null);
  assert.equal(cell("CLI"), null);
  if (/Windows NT/.test(read("apps/ui/src/lib/apps/flag.ts"))) assert.match(row.name, /macOS and Linux/);
});
