import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assembleChangelog, heldFor, parseFragment, readFragments, releaseChangelog, splitFragments, strayFragments, versionBefore } from "../changes.mjs";

const CHANGELOG = `# Changelog

## Unreleased

Ghostly next.

### For users

**Chat**

- One invite.
- Replies.

**Calls**

- Calls.

### For developers

- The CLI.

## 0.4.0

### Added

- Old things.
`;

const fragment = (section: string, body: string) => parseFragment("docs/changelog/unreleased/x.md", `---\nsection: ${section}\n---\n${body}\n`);

describe("changelog fragments", () => {
  it("reads the section and the items", () => {
    expect(fragment("For users / Chat", "- Forwards.")).toMatchObject({ heading: "For users", group: "Chat", body: "- Forwards.", problems: [] });
    expect(fragment("For developers", "- A flag.\n- Another.")).toMatchObject({ heading: "For developers", group: undefined, problems: [] });
  });

  it("refuses what the release could not place", () => {
    expect(parseFragment("docs/changelog/unreleased/x.md", "- no front matter\n").problems).toHaveLength(1);
    expect(fragment("For users / Chat", "Forwards.").problems[0]).toMatch(/list items/);
    expect(fragment("### For users", "- x").problems[0]).toMatch(/without #/);
    expect(fragment("A / B / C", "- x").problems[0]).toMatch(/section/);
    expect(fragment("For users / Chat", "- a — b").problems[0]).toMatch(/dashes/);
  });

  it("adds items at the end of their group, of their heading, or in a new one", () => {
    const out = assembleChangelog(CHANGELOG, [
      fragment("For users / Chat", "- Forwards."),
      fragment("For users / Groups", "- Groups of 32."),
      fragment("For developers", "- A flag."),
      fragment("Fixed", "- A crash."),
    ]);
    expect(out).toBe(`# Changelog

## Unreleased

Ghostly next.

### For users

**Chat**

- One invite.
- Replies.
- Forwards.

**Calls**

- Calls.

**Groups**

- Groups of 32.

### For developers

- The CLI.
- A flag.

### Fixed

- A crash.

## 0.4.0

### Added

- Old things.
`);
  });

  it("changes nothing without fragments", () => {
    expect(assembleChangelog(CHANGELOG, [])).toBe(CHANGELOG);
  });

  it("reads docs/changelog/unreleased/ in name order, without its README", () => {
    const root = mkdtempSync(join(tmpdir(), "changes-"));
    mkdirSync(join(root, "docs/changelog/unreleased"), { recursive: true });
    writeFileSync(join(root, "docs/changelog/unreleased/README.md"), "# How\n");
    writeFileSync(join(root, "docs/changelog/unreleased/b-second.md"), "---\nsection: Fixed\n---\n- B.\n");
    writeFileSync(join(root, "docs/changelog/unreleased/a-first.md"), "---\nsection: Fixed\n---\n- A.\n");
    expect(readFragments(root).map((f: { name: string }) => f.name)).toEqual(["docs/changelog/unreleased/a-first.md", "docs/changelog/unreleased/b-second.md"]);
  });

  it("reads a release an entry is held for, as <major>.<minor>", () => {
    const held = (release: string) => parseFragment("docs/changelog/unreleased/x.md", `---\nsection: Fixed\nrelease: ${release}\n---\n- A.\n`);
    expect(held("1.2")).toMatchObject({ release: "1.2", problems: [] });
    expect(held("10.12")).toMatchObject({ release: "10.12", problems: [] });
    expect(fragment("Fixed", "- A.").release).toBeUndefined();
    for (const wrong of ["1.2.0", "1", "next", '"1.2"', "v1.2", ""]) expect(held(wrong).problems, wrong).toEqual([expect.stringMatching(/"release"/)]);
  });

  it("refuses a front matter key it does not know, or one given twice", () => {
    const front = (lines: string) => parseFragment("docs/changelog/unreleased/x.md", `---\n${lines}\n---\n- A.\n`).problems;
    expect(front("section: Fixed\nrelease: 1.2")).toEqual([]);
    expect(front("section: Fixed\nRelease: 1.2")).toEqual([expect.stringMatching(/"Release: 1\.2"/)]);
    expect(front("section: Fixed\nrelase: 1.2")).toEqual([expect.stringMatching(/"relase" is not a front matter key/)]);
    expect(front("section: Fixed\nreleases: 1.2")).toEqual([expect.stringMatching(/"releases" is not a front matter key/)]);
    expect(front("section: Fixed\n release: 1.2")).toEqual([expect.stringMatching(/" release: 1\.2"/)]);
    expect(front("section: Fixed\nrelease : 1.2")).toEqual([expect.stringMatching(/"release : 1\.2"/)]);
    expect(front("section: Fixed\nrelease: 1.2\nrelease: 1.1")).toEqual([expect.stringMatching(/"release" appears twice/)]);
  });

  it("holds an Apps entry for 1.2 while the repository is before it", () => {
    const entry = (section: string, body: string, version?: string, release?: string) =>
      parseFragment("docs/changelog/unreleased/x.md", `---\nsection: ${section}\n${release ? `release: ${release}\n` : ""}---\n${body}\n`, version).problems;
    const hold = /an Apps entry says "release: 1\.2"/;
    expect(entry("For developers / Apps", "- A store.", "1.1.6")).toEqual([expect.stringMatching(hold)]);
    expect(entry("For developers / Apps", "- A store.")).toEqual([expect.stringMatching(hold)]);
    expect(entry("For users / Chat", "- Behind the apps flag: a card.", "1.1.6")).toEqual([expect.stringMatching(hold)]);
    expect(entry("For developers / WISPs", "- WISP 1200 gains a field.", "1.1.6")).toEqual([expect.stringMatching(hold)]);
    expect(entry("For developers / Apps", "- A store.", "1.1.6", "1.1")).toEqual([expect.stringMatching(hold)]);
    expect(entry("For developers / Apps", "- A store.", "1.1.6", "1.2")).toEqual([]);
    expect(entry("For developers / Apps", "- A store.", "1.1.6", "1.3")).toEqual([]);
    // From 1.2.0 on, Apps ship: an entry about them goes out with the next release like any other.
    expect(entry("For developers / Apps", "- A store.", "1.2.0")).toEqual([]);
    expect(entry("For users / Chat", "- Shared apps open faster.", "1.1.6")).toEqual([]);
  });

  it("keeps a new Unreleased heading, with its note, above the release", () => {
    const changelog = "# Changelog\n\n## Unreleased\n\n<!-- New entries: docs/changelog/unreleased/. -->\n\n## 0.4.0\n\n- Old.\n";
    const out = releaseChangelog(changelog, [fragment("Fixed", "- A crash.")], "0.5.0");
    expect(out).toBe("# Changelog\n\n## Unreleased\n\n<!-- New entries: docs/changelog/unreleased/. -->\n\n## 0.5.0\n\n### Fixed\n\n- A crash.\n\n## 0.4.0\n\n- Old.\n");
    // Twice in a row, nothing lost.
    expect(releaseChangelog(out, [fragment("Fixed", "- Another.")], "0.5.1")).toContain("## Unreleased\n\n<!-- New entries: docs/changelog/unreleased/. -->\n\n## 0.5.1\n\n### Fixed\n\n- Another.\n\n## 0.5.0");
    // A note on several lines stays whole.
    const long = "# Changelog\n\n## Unreleased\n\n<!-- New entries:\ndocs/changelog/unreleased/. -->\n\n## 0.4.0\n";
    expect(releaseChangelog(long, [fragment("Fixed", "- A crash.")], "0.5.0")).toBe(
      "# Changelog\n\n## Unreleased\n\n<!-- New entries:\ndocs/changelog/unreleased/. -->\n\n## 0.5.0\n\n### Fixed\n\n- A crash.\n\n## 0.4.0\n",
    );
    expect(() => releaseChangelog("# Changelog\n\n## 0.4.0\n", [], "0.5.0")).toThrow(/Unreleased/);
  });

  it("compares versions number by number", () => {
    expect(versionBefore("1.1.7", "1.2.0")).toBe(true);
    expect(versionBefore("1.9.0", "1.10.0")).toBe(true);
    expect(versionBefore("1.2.0", "1.2.0")).toBe(false);
    expect(versionBefore("1.2.1", "1.2.0")).toBe(false);
    expect(versionBefore("1.2", "1.2.0")).toBe(false);
    expect(versionBefore("0.9.9", "1.0.0")).toBe(true);
  });

  it("holds an entry until a version of its release or later", () => {
    expect(heldFor("1.2", "1.1.6")).toBe(true);
    expect(heldFor("1.2", "1.1.99")).toBe(true);
    expect(heldFor("1.2", "1.2.0")).toBe(false);
    expect(heldFor("1.2", "1.2.3")).toBe(false);
    expect(heldFor("1.2", "1.3.0")).toBe(false);
    expect(heldFor("1.2", "2.0.0")).toBe(false);
    expect(heldFor("1.10", "1.9.0")).toBe(true);
    expect(heldFor("2.0", "1.9.9")).toBe(true);
    expect(heldFor(undefined, "0.0.1")).toBe(false);

    const now = { name: "now", release: undefined };
    const later = { name: "later", release: "1.2" };
    expect(splitFragments([later, now], "1.1.7")).toEqual({ released: [now], held: [later] });
    expect(splitFragments([later, now], "1.2.0")).toEqual({ released: [later, now], held: [] });
  });

  it("finds entries left in the old changes/ folder", () => {
    const root = mkdtempSync(join(tmpdir(), "changes-"));
    expect(strayFragments(root)).toEqual([]);
    mkdirSync(join(root, "changes"));
    writeFileSync(join(root, "changes/README.md"), "# How\n");
    writeFileSync(join(root, "changes/late.md"), "---\nsection: Fixed\n---\n- Late.\n");
    expect(strayFragments(root)).toEqual(["changes/late.md"]);
  });
});
