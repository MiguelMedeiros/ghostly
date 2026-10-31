import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { releasesNewestFirst } from "../compat-latest-release.mjs";
import { newestPublished } from "../fetch-compat-desktop.mjs";

/** A release's SHA256SUMS.txt with its Linux package. */
const sums = (tag: string) => `abc123  Ghostly_${tag.slice(1)}_amd64.deb\ndef456  Ghostly_${tag.slice(1)}_aarch64.dmg\n`;

/** Releases as GitHub serves them anonymously: a published one's SHA256SUMS.txt, a draft's none (404). */
const served = (published: Record<string, string>) => async (tag: string) => published[tag] ?? null;

describe("the newest release the Desktop compatibility e2e fetches", () => {
  it("is the newest tag when its release is published", async () => {
    const found = await newestPublished(["v1.7.3", "v1.7.2"], served({ "v1.7.3": sums("v1.7.3"), "v1.7.2": sums("v1.7.2") }));
    expect(found).toEqual({ tag: "v1.7.3", sums: sums("v1.7.3") });
  });

  it("is the release before when the newest tag's release is still a draft, which has no public package", async () => {
    const log: string[] = [];
    const found = await newestPublished(["v1.7.3", "v1.7.2"], served({ "v1.7.2": sums("v1.7.2") }), (line) => log.push(line));
    expect(found?.tag).toBe("v1.7.2");
    expect(log).toEqual(["v1.7.3 has no published release (a draft, or still building): trying the release before it"]);
  });

  it("passes over a published release that attaches no Linux package", async () => {
    const found = await newestPublished(["v1.7.3", "v1.7.2"], served({ "v1.7.3": "abc123  Ghostly_1.7.3_aarch64.dmg\n", "v1.7.2": sums("v1.7.2") }));
    expect(found?.tag).toBe("v1.7.2");
  });

  it("is nothing when no release publishes its package", async () => {
    expect(await newestPublished(["v1.7.3"], served({}))).toBeNull();
  });

  it("walks the tags newest first, leaving out the commit under test", () => {
    const lsRemote = "a\trefs/tags/v1.7.3\nb\trefs/tags/v1.10.0\nc\trefs/tags/v1.7.2\nd\trefs/tags/v1.8.0-beta.1\n";
    expect(releasesNewestFirst(lsRemote, "b")).toEqual(["v1.7.3", "v1.7.2"]);
  });

  it("is what the Desktop spec runs against, beside v1.1.5", () => {
    const spec = readFileSync(resolve(import.meta.dirname, "../../../e2e/desktop/compat.spec.ts"), "utf8");
    expect(spec).toContain('release: process.env.E2E_COMPAT_LATEST || "newest"');
    expect(spec).toContain('release: "v1.1.5"');
  });
});
