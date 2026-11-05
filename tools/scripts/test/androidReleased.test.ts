import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Releases attach the native Android app's APK since 1.6.0 (the Release workflow builds it from ANDROID_FROM on, and
 * attaches it when signed): the site says so (llms.txt, the agents FAQ, the roadmap; apps/website/scripts/llms.test.mjs),
 * and the home's download panel offers it to an Android phone. What people read to get Ghostly says the same, and
 * none of it still calls the app planned or not released.
 */
const root = join(import.meta.dirname, "../../..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

const pages = ["README.md", "docs/README.md", "docs/FEATURES.md", "docs/INSTALLATION.md", "docs/WEB.md", "docs/APPS.md", "docs/ANDROID.md"];

/** A line that says the native app is not out: planned, not released, no release has it. */
const notReleased = (line: string) => /Android/.test(line) && /\b(planned|not released|no release has|once it is released)\b/i.test(line);

describe("the native Android app, in the releases since 1.6.0", () => {
  it.each(pages)("%s does not call it unreleased", (page) => {
    expect(
      read(page)
        .split("\n")
        .filter((line) => notReleased(line) && !/iOS/.test(line)),
    ).toEqual([]);
  });

  it("is a line the check would catch", () => {
    expect(notReleased("A native Android app is planned and not released: no release has an APK.")).toBe(true);
    expect(notReleased("[The native Android app (planned, not released)](ANDROID.md)")).toBe(true);
    expect(notReleased("Install it as an app on a computer, Android or iPhone.")).toBe(false);
  });

  it("is offered where a person on Android looks first, with the APK's name and the unknown-apps step", () => {
    const install = read("docs/INSTALLATION.md");
    const android = install.slice(install.indexOf("\n## Android\n"), install.indexOf("\n## Browser extension"));
    expect(android).toMatch(/Each release since 1\.6\.0 attaches the native Android app/);
    expect(android).toContain("ghostly-<version>-android-arm64.apk");
    expect(android).toMatch(/install unknown apps/);
    expect(android).toMatch(/app\.ghostly\.tools/);
  });

  it("matches the Release workflow, which builds the APK from ANDROID_FROM on", () => {
    const from = /^ {2}ANDROID_FROM: "(\d+\.\d+\.\d+)"$/m.exec(read(".github/workflows/release.yml"))?.[1];
    expect(read("docs/ANDROID.md")).toContain(`\`ANDROID_FROM\` on (\`.github/workflows/release.yml\`, \`${from}\` today)`);
  });
});
