#!/usr/bin/env node
/**
 * Writes the last matrix run (test-results/matrix-summary/summary.md, from
 * e2e/matrix/reporter.ts) into docs/TESTING.md, between its own markers.
 *
 * docs/TESTING.md's generated feature map belongs to scripts/test-map.mjs; this
 * touches only the "Combination matrix" section, and adds it at the end when it
 * is not there yet (or creates the file when nothing else has).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const summaryPath = resolve(root, process.argv[2] ?? "test-results/matrix-summary/summary.md");
const docsPath = join(root, "docs/TESTING.md");
const BEGIN = "<!-- matrix:begin (scripts/matrix-docs.mjs writes this section; edit the text above it) -->";
const END = "<!-- matrix:end -->";

if (!existsSync(summaryPath)) {
  console.error(`No matrix summary at ${summaryPath}: run \`npm run e2e:matrix\` first.`);
  process.exit(1);
}
const summary = readFileSync(summaryPath, "utf8").trim();
const date = new Date().toISOString().slice(0, 10);
const block = `${BEGIN}\n\nLast full run: ${date}.\n\n${summary}\n\n${END}`;

const intro = `## Combination matrix

Each feature is tested on its own elsewhere; this section is about the pieces together. \`e2e/matrix/\` describes the
dimensions (clients, transport, delivery, wallet, rail and source, identity proof, groups, profile, locale, viewport)
and their constraints as data, generates the fewest scenarios that put every pair of values together at least once
(and every client × transport × delivery combination), and runs each one as a whole story: pair, talk both ways,
send a file, share a proof, pay, go offline and back, restore. A scenario whose infrastructure is not up is skipped
with the reason, not failed.

\`\`\`bash
npm run e2e:matrix                          # every scenario (reads .env.e2e from npm run e2e:infra:up)
npm run e2e:matrix -- --only <id>           # reproduce one
npm run e2e:matrix -- --list                # print the matrix
npm run e2e:matrix -- --docs                # and write the table below
\`\`\`
`;

let docs = existsSync(docsPath) ? readFileSync(docsPath, "utf8") : "# Testing\n";
const start = docs.indexOf(BEGIN);
const end = docs.indexOf(END);
if (start >= 0 && end > start) docs = docs.slice(0, start) + block + docs.slice(end + END.length);
else docs = `${docs.trimEnd()}\n\n${intro}\n${block}\n`;
writeFileSync(docsPath, docs.endsWith("\n") ? docs : `${docs}\n`);
console.log(`docs/TESTING.md: combination matrix updated (${date}).`);
