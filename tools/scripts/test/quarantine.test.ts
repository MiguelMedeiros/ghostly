import { describe, expect, it } from "vitest";
import { withoutQuarantine } from "../../../e2e/support/quarantine";
import { checkEntries, e2eSources, fileEntries, specMarks } from "../quarantine.mjs";

const TODAY = "2026-11-14";

describe("quarantine expiry", () => {
  const entry = (until: string, issue = 5087) => ({ where: "e2e/web/a.spec.ts:3", issue, until });

  it("lets an entry through until its last day, and at most 7 days ahead", () => {
    expect(checkEntries([entry("2026-11-14"), entry("2026-11-21")], { today: TODAY })).toEqual([]);
  });

  it("fails an entry past its date, naming it in one line", () => {
    expect(checkEntries([entry("2026-11-13")], { today: TODAY })).toEqual([
      "e2e/web/a.spec.ts:3: the quarantine for #5087 ended on 2026-11-13: fix the test and take it out, or move the date (7 days at most)",
    ]);
  });

  it("fails an entry more than 7 days ahead", () => {
    expect(checkEntries([entry("2026-11-22")], { today: TODAY })).toEqual([
      "e2e/web/a.spec.ts:3: the quarantine for #5087 lasts until 2026-11-22, more than 7 days from today (2026-11-21 at most)",
    ]);
  });

  it("fails a date that is not one", () => {
    expect(checkEntries([entry("2026-02-30")], { today: TODAY })).toEqual([
      'e2e/web/a.spec.ts:3: the quarantine for #5087 says until "2026-02-30", not a date (YYYY-MM-DD)',
    ]);
  });

  it("fails an entry whose issue is closed or is not a flake", () => {
    const issues = new Map([
      [5087, { open: false, flake: true }],
      [5375, { open: true, flake: false }],
      [5654, { open: true, flake: true }],
    ]);
    expect(checkEntries([entry("2026-11-20"), entry("2026-11-20", 5375), entry("2026-11-20", 5654), entry("2026-11-20", 1)], { today: TODAY, issues })).toEqual([
      "e2e/web/a.spec.ts:3: the quarantine's issue #5087 is closed: take the test out of quarantine",
      "e2e/web/a.spec.ts:3: the quarantine's issue #5375 is not labelled kind:flake",
      "e2e/web/a.spec.ts:3: the quarantine's issue #1 was not found",
    ]);
  });
});

describe("quarantine marks", () => {
  it("reads a tagged test's quarantine line", () => {
    const text = [
      'import { test } from "@playwright/test";',
      "",
      "// quarantine: #5087 until 2026-11-20",
      'test("sends", { tag: ["@feature:chat.paired.send", "@quarantine"] }, async () => {});',
    ].join("\n");
    expect(specMarks("e2e/web/a.spec.ts", text)).toEqual({ entries: [{ where: "e2e/web/a.spec.ts:4", issue: 5087, until: "2026-11-20" }], errors: [] });
  });

  it("refuses a tag without its line, and a line without its tag", () => {
    const text = ['test("a", { tag: ["@quarantine"] }, async () => {});', "", "", "", "", "", "// quarantine: #1 until 2026-11-20", 'test("b", async () => {});'].join("\n");
    expect(specMarks("e2e/web/a.spec.ts", text).errors).toEqual([
      "e2e/web/a.spec.ts:1: @quarantine without a `// quarantine: #<issue> until <YYYY-MM-DD>` line above it",
      "e2e/web/a.spec.ts:7: a quarantine line with no @quarantine test under it",
    ]);
  });

  it("counts @quarantine in a title or a describe as the tag, and refuses it without its line", () => {
    const text = ['test("a title that says @quarantine in words", async () => {});', "", "", "", "", "", 'test.describe(`slow @quarantine`, () => {});'].join("\n");
    expect(specMarks("e2e/web/a.spec.ts", text).errors).toEqual([
      "e2e/web/a.spec.ts:1: @quarantine without a `// quarantine: #<issue> until <YYYY-MM-DD>` line above it",
      "e2e/web/a.spec.ts:7: @quarantine without a `// quarantine: #<issue> until <YYYY-MM-DD>` line above it",
    ]);
  });

  it("leaves a longer tag alone, as the gate does", () => {
    const text = ['test("a", { tag: ["@quarantine-later", "@quarantine:x"] }, async () => {});', 'test("b @quarantined", async () => {});'].join("\n");
    expect(specMarks("e2e/web/a.spec.ts", text)).toEqual({ entries: [], errors: [] });
  });

  // The gate's filter (e2e/support/quarantine.ts) drops a test when its titles and tags, joined by spaces, match: the
  // check must count every one it drops, or a test leaves the gate with no date.
  it("counts every test the gate's filter drops", () => {
    const [drop] = withoutQuarantine({}).grepInvert as RegExp[];
    const cases = [
      { source: 'test("sends", { tag: ["@quarantine"] }, f);', grep: "sends @quarantine" },
      { source: 'test("a title that says @quarantine in words", f);', grep: "a title that says @quarantine in words" },
      { source: "test.describe(`slow @quarantine`, f);", grep: "slow @quarantine inside it" },
      { source: 'test("a", { tag: ["@quarantine-later"] }, f);', grep: "a @quarantine-later" },
      { source: 'test("a", { tag: ["@quarantine:x"] }, f);', grep: "a @quarantine:x" },
      { source: 'test("b @quarantined", f);', grep: "b @quarantined" },
      { source: 'test("c", { tag: ["@feature:chat.quarantine"] }, f);', grep: "c @feature:chat.quarantine" },
    ];
    for (const { source, grep } of cases) {
      expect(specMarks("e2e/web/a.spec.ts", source).errors.length > 0, source).toBe(drop.test(grep));
    }
  });

  // A tag kept in a helper's constant reaches a test as the tag: the helpers are read too, all but the filter itself.
  it("reads every e2e source file, helpers included", () => {
    const files = e2eSources();
    expect(files).toContain("e2e/web/menus.spec.ts");
    expect(files).toContain("e2e/support/appStore.ts");
    expect(files).not.toContain("e2e/support/quarantine.ts");
    expect(files.some((f) => f.includes("node_modules/"))).toBe(false);
  });

  it("reads the unit test list", () => {
    const list = [{ file: "packages/cli/test/a.test.ts", config: "packages/cli/vitest.config.ts", issue: 4237, until: "2026-11-18" }];
    expect(fileEntries(list, () => true)).toEqual({ entries: [{ where: "packages/cli/test/a.test.ts", issue: 4237, until: "2026-11-18" }], errors: [] });
    expect(fileEntries([{ ...list[0], file: "packages/cli/test/gone.test.ts" }], (path) => path.endsWith("config.ts")).errors).toEqual([
      "tools/scripts/quarantine.json: packages/cli/test/gone.test.ts is not a file",
    ]);
    expect(fileEntries([{ file: "a.test.ts" }], () => true).errors).toEqual([
      "tools/scripts/quarantine.json: an entry needs file, config, issue (a number) and until",
    ]);
  });
});
