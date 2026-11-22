import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The site is built from `main` and served from it, so a link into the repository names its file on `main`: the file
// the page was built from. A link to `dev` breaks on the live site as soon as dev moves or deletes the file, until the
// next release (dev's #7562 deleted a test file that the released /wisps/902-group-mesh still linked on dev).
const site = fileURLToPath(new URL("..", import.meta.url));
const DEV_LINK =
  /(?:github\.com\/MiguelMedeiros\/ghostly\/(?:blob|tree|raw|edit)|raw\.githubusercontent\.com\/MiguelMedeiros\/ghostly|\$\{(?:REPO|REPO_URL|GITHUB)\}(?:\/(?:blob|tree|raw))?)\/dev(?:\/|["'`])/;

function sources(dir) {
  return readdirSync(join(site, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(?:ts|tsx|mjs)$/.test(entry.name) && !entry.name.endsWith(".test.mjs") ? [path] : [];
  });
}

test("the site links the repository's files on main, the branch it is built from", () => {
  const files = ["app", "components", "content", "lib", "scripts"].flatMap(sources).concat("next.config.ts");
  assert.ok(files.length > 100, `read ${files.length} files`);
  const onDev = files.flatMap((file) =>
    readFileSync(join(site, file), "utf8")
      .split("\n")
      .flatMap((line, i) => (DEV_LINK.test(line) ? [`${relative(site, join(site, file))}:${i + 1}`] : [])),
  );
  assert.deepEqual(onDev, []);
});

test("the check sees each way the site writes a repository link to dev", () => {
  for (const line of [
    "`https://github.com/MiguelMedeiros/ghostly/blob/dev/${normalized}${hash}`",
    "`${REPO_URL}/blob/dev/${reference.sourcePath}`",
    '"https://github.com/MiguelMedeiros/ghostly/tree/dev/packages/sdk"',
    '"https://raw.githubusercontent.com/MiguelMedeiros/ghostly/dev"',
    "`${REPO}/blob/dev/LICENSE`",
    "`${GITHUB}/dev/docs/wisps/NUMBERING.md`",
  ])
    assert.match(line, DEV_LINK, line);
  for (const line of [
    "`${REPO_URL}/blob/main/${reference.sourcePath}`",
    '"https://github.com/MiguelMedeiros/ghostly/releases/download/v1.11.4/x.dmg"',
    "`${REPO}/blob/main/docs/dev/notes.md`",
  ])
    assert.doesNotMatch(line, DEV_LINK, line);
});
