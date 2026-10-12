// The site's Docker build sees only what Dockerfile.dockerignore lets through and the Dockerfile copies. sync-references
// refuses a WISP's link to a Markdown file that is not there (doc-links.mjs), so a WISP that links to a file outside
// docs/ builds in CI (a whole checkout) and fails in the image: the site of 1.2.2 could not be built for that.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const dockerfile = readFileSync(resolve(here, "../Dockerfile"), "utf8");
const ignore = readFileSync(resolve(here, "../Dockerfile.dockerignore"), "utf8").split("\n");

/** Relative links to Markdown files, as doc-links.mjs reads them: code is not read as links. */
function linkedMarkdown(file) {
  const prose = readFileSync(file, "utf8").replace(/^```[\s\S]*?^```/gm, "").replace(/`[^`\n]*`/g, "");
  return [...prose.matchAll(/\]\(([^)\s]+)/g)]
    .map((m) => m[1])
    .filter((url) => !/^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(url) && /\.md$/i.test(url.split("#")[0]))
    .map((url) => relative(root, normalize(join(dirname(file), url.split("#")[0]))).split("\\").join("/"));
}

test("every Markdown file a WISP links to outside docs/ is in the image's build context and copied", () => {
  const wisps = resolve(root, "docs/wisps");
  const outside = new Set();
  for (const name of readdirSync(wisps)) {
    if (!name.endsWith(".md")) continue;
    for (const target of linkedMarkdown(join(wisps, name))) if (!target.startsWith("docs/")) outside.add(target);
  }
  assert.ok(outside.size > 0, "the WISPs link to files outside docs/ (the CLI reference, at least)");
  for (const target of outside) {
    assert.ok(ignore.includes(`!${target}`), `Dockerfile.dockerignore lets ${target} through`);
    // One COPY line may name several sources (the two .github files share a line).
    assert.ok(dockerfile.split("\n").some((line) => line.startsWith("COPY ") && line.split(/\s+/).slice(1, -1).includes(target)), `the Dockerfile copies ${target}`);
  }
});
