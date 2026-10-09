import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A folder with a lockfile (or a Dockerfile) of its own that .github/dependabot.yml does not list gets no update
 * pull request, and its advisories pile up unseen. This holds the file to the tree: every lockfile and Dockerfile is
 * under a `directory` of its ecosystem, and every `directory` it lists exists (a moved folder is caught here).
 */
const root = resolve(import.meta.dirname, "../../..");

const ECOSYSTEM: Record<string, string> = { "package-lock.json": "npm", "Cargo.lock": "cargo", Dockerfile: "docker" };
/** Folders made by an install or a build: no checkout has them. */
const MADE = new Set(["node_modules", "target", "dist", "build", "out"]);

/** Every lockfile and Dockerfile of the tree, as `<ecosystem> /<folder>`. */
function manifests(dir = root, folder = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return MADE.has(entry.name) || entry.name.startsWith(".") ? [] : manifests(join(dir, entry.name), `${folder}/${entry.name}`);
    return ECOSYSTEM[entry.name] ? [`${ECOSYSTEM[entry.name]} ${folder || "/"}`] : [];
  });
}

/** Every `<ecosystem> <directory>` the configuration lists. */
function watched(text: string): string[] {
  return text.split(/^ {2}- package-ecosystem: /m).slice(1).flatMap((block) => {
    const ecosystem = block.match(/^[\w-]+/)![0];
    const one = block.match(/^ {4}directory: (\S+)$/m)?.[1];
    const many = block.match(/^ {4}directories: \[(.+)\]$/m)?.[1].split(",").map((d) => d.trim());
    return [...(one ? [one] : []), ...(many ?? [])].map((directory) => `${ecosystem} ${directory}`);
  });
}

describe("Dependabot's configuration", () => {
  const config = watched(readFileSync(join(root, ".github/dependabot.yml"), "utf8"));

  it("reads both forms a block names its folders in", () => {
    const sample = [
      "updates:",
      "  - package-ecosystem: npm",
      "    directory: /",
      "    groups:",
      "      npm:",
      '        patterns: ["*"]',
      "  - package-ecosystem: docker",
      "    directories: [/apps/web, /apps/website]",
    ].join("\n");
    expect(watched(sample)).toEqual(["npm /", "docker /apps/web", "docker /apps/website"]);
  });

  it("watches every lockfile and Dockerfile in the repository", () => {
    expect(manifests().filter((m) => !config.includes(m))).toEqual([]);
  });

  it("lists only folders the repository has", () => {
    expect(config.filter((entry) => !existsSync(join(root, entry.split(" ")[1])))).toEqual([]);
  });
});
