import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { newestRelease } from "../compat-latest-release.mjs";

const read = (file: string) => readFileSync(resolve(import.meta.dirname, "../../..", file), "utf8");

/** `git ls-remote --tags` lines of annotated tags: the tag object, then the commit it points at. */
const annotated = (tag: string, commit: string) => `tag-of-${commit}\trefs/tags/${tag}\n${commit}\trefs/tags/${tag}^{}\n`;

describe("the newest release the compatibility e2e tests against", () => {
  it("is the highest version by number, not by text", () => {
    const tags = annotated("v1.9.0", "a") + annotated("v1.10.0", "b") + annotated("v1.7.2", "c");
    expect(newestRelease(tags, "dev-tip")).toBe("v1.10.0");
  });

  it("is the release before when the commit under test is the newest tag, as in a release's gate", () => {
    const tags = annotated("v1.7.2", "a") + annotated("v1.7.3", "b");
    expect(newestRelease(tags, "b")).toBe("v1.7.2");
    expect(newestRelease(tags, "dev-tip")).toBe("v1.7.3");
  });

  it("knows a lightweight tag's commit too", () => {
    expect(newestRelease("a\trefs/tags/v1.7.3\n" + annotated("v1.7.2", "b"), "a")).toBe("v1.7.2");
  });

  it("takes no pre-release or stray tag", () => {
    const tags = annotated("v1.7.2", "a") + annotated("v1.8.0-beta.1", "b") + annotated("translation-runtime-v9.0.0", "c") + annotated("v2", "d");
    expect(newestRelease(tags, "dev-tip")).toBe("v1.7.2");
    expect(newestRelease(annotated("v1.8.0-beta.1", "b"), "dev-tip")).toBeNull();
  });

  it("is what the workflow builds and caches, and hands to the tests", () => {
    const workflow = read(".github/workflows/e2e-compat.yml");
    expect(workflow).toContain("node tools/scripts/compat-latest-release.mjs");
    expect(workflow).toContain("key: compat-web-v0.4.0-v1.1.4-v1.1.5-${{ steps.latest.outputs.tag }}-");
    expect(workflow).toContain('node tools/scripts/build-compat-web.mjs --tag "$E2E_COMPAT_LATEST"');
    expect(workflow).toMatch(/run: npm run test:e2e:compat\n\s+env:\n\s+E2E_COMPAT_LATEST: \$\{\{ steps\.latest\.outputs\.tag \}\}/);
  });
});
