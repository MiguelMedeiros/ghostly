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

/** Every Node image a Dockerfile of the tree builds on, as `<file> node:<major>`. */
function nodeImages(dir = root, folder = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return MADE.has(entry.name) || entry.name.startsWith(".") ? [] : nodeImages(join(dir, entry.name), `${folder}/${entry.name}`);
    if (entry.name !== "Dockerfile") return [];
    return [...readFileSync(join(dir, entry.name), "utf8").matchAll(/^FROM node:(\d+)/gm)].map((from) => `${folder}/Dockerfile node:${from[1]}`);
  });
}

/**
 * Node's long-term lines: the even majors up to 26, and every major from 27 on (one release a year since then, each
 * long-term). 23 and 25 were supported for eight months.
 */
const longTerm = (major: number) => major >= 27 || major % 2 === 0;

describe("Dependabot's configuration", () => {
  const text = readFileSync(join(root, ".github/dependabot.yml"), "utf8");
  const config = watched(text);

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

  it("leaves a Node image on the major its Dockerfile names", () => {
    const docker = text.split(/^ {2}- package-ecosystem: /m).find((block) => block.startsWith("docker"))!;
    expect(docker).toMatch(/^ {4}ignore:\n {6}- dependency-name: node\n {8}update-types: \["version-update:semver-major"\]$/m);
  });

  it("builds every image on a long-term Node", () => {
    expect(nodeImages().length).toBeGreaterThan(0);
    expect(nodeImages().filter((image) => !longTerm(Number(image.split("node:")[1])))).toEqual([]);
  });

  it("lists only folders the repository has", () => {
    expect(config.filter((entry) => !existsSync(join(root, entry.split(" ")[1])))).toEqual([]);
  });
});
