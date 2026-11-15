import { describe, expect, it } from "vitest";
import { checkEntries, fileEntries, specMarks } from "../quarantine.mjs";

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
