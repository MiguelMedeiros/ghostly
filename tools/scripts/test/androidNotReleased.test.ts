import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The native Android app is planned and in no release yet (the owner's decision, 2026-10-10). What people read to get
 * Ghostly (the README, the user docs, the site's own text) must not offer it or call it available, and the roadmap
 * has it as planned. On an Android phone, Ghostly is the web app. docs/ANDROID.md, the developers' page, says where
 * the work stands. This file goes when the app is released.
 */
const root = join(import.meta.dirname, "../../..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

const site = readdirSync(join(root, "apps/website/content"))
  .filter((name) => name.endsWith(".ts"))
  .map((name) => `apps/website/content/${name}`);
const pages = ["README.md", "docs/README.md", "docs/FEATURES.md", "docs/INSTALLATION.md", "docs/WEB.md", "docs/APPS.md", ...site];

/** A line that offers the native app: an APK to download, or the app named as something a person has. */
const offers = (line: string) =>
  /\.apk\b|releases? attach|there is also a native app|\b(the|in the|on the) Android app\b/i.test(line) && !/\b(planned|not released|no release has)\b/i.test(line);

describe("the native Android app, while it is not released", () => {
  it.each(pages)("%s does not offer it", (page) => {
    expect(
      read(page)
        .split("\n")
        .filter((line) => offers(line)),
    ).toEqual([]);
  });

  it("is a line the check would catch", () => {
    expect(offers("Releases attach `ghostly-<version>-android-arm64.apk`, signed with Ghostly's key.")).toBe(true);
    expect(offers("Not on Windows, the Android app or the browser extension yet.")).toBe(true);
    expect(offers("On Android there is also a native app ([ANDROID.md](ANDROID.md)).")).toBe(true);
    expect(offers("Install it as an app on a computer, Android or iPhone.")).toBe(false);
    expect(offers("A native Android app is planned and not released: no release has an APK.")).toBe(false);
  });

  it("is planned on the roadmap, which the site's roadmap page is generated from", () => {
    const roadmap = read("docs/wisps/ADAPTER-ROADMAP.md").split("\n");
    const row = roadmap.find((line) => line.startsWith("| Ghostly for Android |")) ?? "";
    expect(row.split("|")[3].trim()).toMatch(/^\*\*Planned\*\*: not in release 1\.2/);
    expect(row).not.toMatch(/In implementation|for 1\.2\*\*|releases attach/i);
    const track = roadmap.filter((line) => /native Android app/.test(line) && line.startsWith("- **"));
    expect(track).toHaveLength(1);
    expect(track[0]).toMatch(/^- \*\*Planned\*\*: /);
    expect(track[0]).not.toMatch(/in testing|for 1\.2/);
  });

  it("is told apart from the web app where a person on Android looks first", () => {
    const install = read("docs/INSTALLATION.md");
    const android = install.slice(install.indexOf("\n## Android\n"), install.indexOf("\n## Browser extension"));
    expect(android).toMatch(/Ghostly is the web app/);
    expect(android).toMatch(/planned and not released: no release has an APK/);
  });
});
