import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
// covers: transport.hyperdht

/**
 * hyperdht has four copies behind three lockfiles: packages/browser and packages/cli (the root's), the Desktop's
 * sidecar and the relay for browsers. They talk to each other, and tools/patches/hyperdht+<version>.patch is named by
 * version, so they move together. A weekly Dependabot group once moved the root's alone: the lockfile took a range
 * where the packages pin exactly, patch-package applied the patch with a "version mismatch" warning and failed
 * nothing, and the sidecar and the relay stayed behind. This holds every copy to one version.
 */
const root = resolve(import.meta.dirname, "../../..");
const json = (path: string) => JSON.parse(readFileSync(join(root, path), "utf8"));

/** The folders that depend on hyperdht, each with the lockfile that resolves it. */
const COPIES = [
  { folder: "packages/browser", lock: "package-lock.json" },
  { folder: "packages/cli", lock: "package-lock.json" },
  { folder: "native/transports/hyperdht", lock: "native/transports/hyperdht/package-lock.json" },
  { folder: "infra/services/hyperdht-relay", lock: "infra/services/hyperdht-relay/package-lock.json" },
];

const pinned = (folder: string): string => {
  const manifest = json(`${folder}/package.json`);
  return manifest.dependencies?.hyperdht ?? manifest.devDependencies?.hyperdht;
};

it("every copy of hyperdht pins the same exact version", () => {
  const versions = COPIES.map(({ folder }) => `${folder} ${pinned(folder)}`);
  const version = pinned(COPIES[0].folder);
  expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  expect(versions).toEqual(COPIES.map(({ folder }) => `${folder} ${version}`));
});

it("every lockfile resolves that version, and records it as the packages pin it", () => {
  const version = pinned(COPIES[0].folder);
  for (const { folder, lock } of COPIES) {
    const packages = json(lock).packages;
    expect(`${lock} ${packages["node_modules/hyperdht"].version}`).toBe(`${lock} ${version}`);
    const own = packages[lock === "package-lock.json" ? folder : ""];
    expect(`${folder} ${own.dependencies?.hyperdht ?? own.devDependencies?.hyperdht}`).toBe(`${folder} ${version}`);
  }
});

it("the patch is named by that version, so patch-package applies it without a version mismatch", () => {
  const patches = readdirSync(join(root, "tools/patches")).filter((name) => name.startsWith("hyperdht+"));
  expect(patches).toEqual([`hyperdht+${pinned(COPIES[0].folder)}.patch`]);
});
