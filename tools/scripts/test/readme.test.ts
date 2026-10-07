import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The README is the repo's front page on GitHub and docs/INSTALLATION.md is where it sends people to check a download.
 * Every local link and image in them has to resolve (anchors too), and both name the same key that signs the
 * release's SHA256SUMS.txt, with the steps to check it. #1437 once undid #1432's README by being committed on a tree
 * from before it; these checks fail when that happens again.
 */
const root = join(import.meta.dirname, "../../..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

/** GitHub's heading anchor: lower case, punctuation dropped, spaces to hyphens. */
const slug = (heading: string) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s/g, "-");

const anchors = (path: string) =>
  new Set(
    read(path)
      .split("\n")
      .filter((line) => /^#{1,6}\s/.test(line))
      .map((line) => slug(line.replace(/^#+\s*/, ""))),
  );

/** Local targets of Markdown links/images and HTML href/src/srcset attributes. */
function localTargets(markdown: string): string[] {
  const found = [
    ...[...markdown.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]),
    ...[...markdown.matchAll(/\b(?:href|src|srcset)="([^"]+)"/g)].map((m) => m[1]),
  ];
  return found.filter((target) => !/^[a-z]+:/i.test(target));
}

function broken(path: string): string[] {
  const base = dirname(path);
  const out: string[] = [];
  for (const target of localTargets(read(path))) {
    const [file, anchor] = target.split("#");
    const resolved = file ? join(base, file) : path;
    if (!existsSync(join(root, resolved))) {
      out.push(target);
      continue;
    }
    if (anchor && resolved.endsWith(".md") && !anchors(resolved).has(anchor)) out.push(target);
  }
  return out;
}

const FINGERPRINT = /\b[0-9A-F]{40}\b/g;

describe("README and INSTALLATION", () => {
  it("every local link, image and anchor resolves", () => {
    expect(broken("README.md")).toEqual([]);
    expect(broken("docs/INSTALLATION.md")).toEqual([]);
  });

  it("the README shows its logo and hero from docs/assets/readme", () => {
    const readme = read("README.md");
    for (const asset of ["logo-dark.svg", "logo-light.svg", "hero.webp"]) {
      expect(readme).toContain(`docs/assets/readme/${asset}`);
      expect(existsSync(join(root, "docs/assets/readme", asset))).toBe(true);
    }
  });

  it("both name the same release signing key, and INSTALLATION says how to check it", () => {
    const readmeKeys = new Set(read("README.md").match(FINGERPRINT));
    const installation = read("docs/INSTALLATION.md");
    const installKeys = new Set(installation.match(FINGERPRINT));
    expect(readmeKeys.size).toBe(1);
    expect([...installKeys]).toEqual([...readmeKeys]);
    const [key] = readmeKeys;
    expect(installation).toContain(`gpg --keyserver hkps://keys.openpgp.org --recv-keys ${key}`);
    expect(installation).toContain("gpg --verify SHA256SUMS.txt.asc SHA256SUMS.txt");
    expect(read("README.md")).toContain("docs/INSTALLATION.md#desktop-app");
  });
});
