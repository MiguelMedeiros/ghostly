import { describe, expect, it } from "vitest";
import { npmPackages } from "../security-scan.mjs";

/**
 * The scan asks OSV about each package by its name and version. An npm alias (`"old-lodash": "npm:lodash@4.17.15"`)
 * sits at `node_modules/old-lodash` and names the real package in the entry: asked about `old-lodash`, OSV knows
 * nothing, and an advisory on lodash 4.17.15 never reaches the workflow.
 */
describe("The dependency scan's npm packages", () => {
  const packages = npmPackages("tools/scripts/test/fixtures/alias-lock.json");

  it("names an aliased package by the package it installs, not by its alias", () => {
    expect(packages.map((p: { name: string; version: string }) => `${p.name}@${p.version}`).sort()).toEqual(["@other/real@2.0.0", "lodash@4.17.15", "lodash@4.17.20"]);
  });

  it("keeps each entry's lockfile and whether it is a dev dependency", () => {
    expect(packages.find((p: { name: string }) => p.name === "@other/real")).toMatchObject({ ecosystem: "npm", dev: true, lockfile: "tools/scripts/test/fixtures/alias-lock.json" });
  });
});
