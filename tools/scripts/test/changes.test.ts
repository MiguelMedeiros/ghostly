import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assembleChangelog, parseFragment, readFragments } from "../changes.mjs";

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
});
