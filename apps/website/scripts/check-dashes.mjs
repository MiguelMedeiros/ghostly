// Fails when an em dash (U+2014) or an en dash (U+2013) is back in the
// site's copy, or in the documents the site renders. Write a period, a comma,
// a colon or parentheses instead, and a hyphen or "to" in a range ("00-99",
// "2 to 4 s").
// Generated files are left out: fix their sources (docs/wisps) and run
// `npm run sync:references`.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { extname, relative, resolve } from "node:path";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const scanned = [
  "apps/website/app",
  "apps/website/components",
  "apps/website/content",
  "apps/website/lib",
  "apps/website/scripts",
  "docs/wisps",
  // Published under /reference by sync-references.mjs.
  "docs/PROTOCOL.md",
  "docs/SDK.md",
  "docs/USDT-INTEGRATION.md",
  "docs/DHT-DELIVERY.md",
  // On GitHub only, linked from the site's footer: the site's copy rules still apply.
  ".github/CONTRIBUTING.md",
  ".github/SECURITY.md",
  // Carried in /llms-full.txt by llms.mjs.
  "docs/CLI.md",
  "docs/AI-AGENTS.md",
  "packages/cli/SKILL.md",
];
const generated = new Set([
  "apps/website/lib/reference-index.json",
  "apps/website/lib/wisp-numbering.json",
  "apps/website/lib/roadmap-candidates.json",
  "apps/website/lib/roadmap-tracks.json",
  "apps/website/lib/levels.json",
  "apps/website/lib/code-snippets.json",
  "apps/website/lib/agent-prompt.json",
  "docs/wisps/NUMBERING.md",
]);
const text = new Set([".ts", ".tsx", ".js", ".mjs", ".css", ".md", ".json"]);
const dash = /[\u2013\u2014]/;

function* files(path) {
  if (statSync(path).isDirectory()) {
    for (const name of readdirSync(path)) yield* files(resolve(path, name));
  } else if (text.has(extname(path))) {
    yield path;
  }
}

const found = [];
for (const entry of scanned) {
  for (const path of files(resolve(root, entry))) {
    const file = relative(root, path);
    // components/app is the app's deck, copied by sync-app-deck.mjs: it renders the site's words, not its own.
    if (generated.has(file) || file.startsWith("apps/website/components/app/")) continue;
    readFileSync(path, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (dash.test(line)) found.push(`${file}:${i + 1}: ${line.trim().slice(0, 140)}`);
      });
  }
}
if (found.length) {
  console.error(`No em or en dashes in the site's copy (${found.length} found):\n`);
  console.error(found.join("\n"));
  console.error(
    '\nRewrite the sentence with a period, a comma, a colon or parentheses; use a hyphen or "to" in ranges.',
  );
  process.exit(1);
}
console.log("No em or en dashes in the site's copy.");
