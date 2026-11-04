import { describe, expect, it } from "vitest";
import { bump, type Fixture, runGate } from "./autoreleaseGate.ts";

type File = Fixture["files"][number] & { status?: string };
const branch = (...files: File[]) => bump({ files });

// The files of a Rust advisory fix that rebuilt Iroh for browsers: the compare API lists the wasm with no lines.
const IROH_REBUILD: File[] = [
  { filename: "packages/iroh-web/pkg/BUILD.json", additions: 5, deletions: 5, status: "modified" },
  { filename: "packages/iroh-web/pkg/ghostly_iroh_web.d.ts", additions: 13, deletions: 15, status: "modified" },
  { filename: "packages/iroh-web/pkg/ghostly_iroh_web.js", additions: 37, deletions: 46, status: "modified" },
  { filename: "packages/iroh-web/pkg/ghostly_iroh_web_bg.wasm", additions: 0, deletions: 0, status: "modified" },
  { filename: "packages/iroh-web/pkg/ghostly_iroh_web_bg.wasm.d.ts", additions: 13, deletions: 15, status: "modified" },
];

describe("the security autorelease gate's line limit", () => {
  it("refuses a rebuilt Iroh wasm, which GitHub counts as no lines, in both modes", () => {
    for (const mode of ["all", "deps"] as const) {
      const run = runGate(branch(...IROH_REBUILD), mode);
      expect(run.code, mode).toBe(1);
    }
    expect(runGate(branch(...IROH_REBUILD)).stderr).toContain("changes a binary file: packages/iroh-web/pkg/ghostly_iroh_web_bg.wasm");
  });

  it("refuses a binary file added, changed or removed, whatever GitHub counts", () => {
    for (const file of [
      { filename: "apps/desktop/gen/android/gradle/wrapper/gradle-wrapper.jar", additions: 0, deletions: 0, status: "modified" },
      { filename: "packages/cli/prebuilt/addon.node", additions: 0, deletions: 0, status: "added" },
      { filename: "apps/web/public/icon.png", additions: 0, deletions: 0, status: "removed" },
      { filename: "packages/iroh-web/pkg/ghostly_iroh_web_bg.wasm", additions: 3, deletions: 3, status: "modified" },
      { filename: "packages/iroh-web/pkg/notes.txt", previous_filename: "packages/iroh-web/pkg/ghostly_iroh_web_bg.wasm", additions: 0, deletions: 0, status: "renamed" },
    ]) {
      const run = runGate(branch(file));
      expect(run.code, file.filename).toBe(1);
      expect(run.stderr).toContain("changes a binary file");
    }
  });

  it("refuses any other file GitHub counts no lines in: a pure rename, a mode change, an unknown binary", () => {
    for (const file of [
      { filename: "packages/core/src/moved.ts", previous_filename: "packages/core/src/old.ts", additions: 0, deletions: 0, status: "renamed" },
      { filename: "tools/scripts/run.sh", additions: 0, deletions: 0, status: "changed" },
      { filename: "packages/iroh-web/pkg/blob", additions: 0, deletions: 0, status: "modified" },
    ]) {
      const run = runGate(branch(file));
      expect(run.code, file.filename).toBe(1);
      expect(run.stderr).toContain(`changes a file with no countable lines (${file.status}): ${file.filename}`);
    }
  });

  it("still counts text files toward the limit", () => {
    expect(runGate(branch({ filename: "packages/iroh-web/pkg/ghostly_iroh_web.js", additions: 37, deletions: 46, status: "modified" })).code).toBe(0);
    const run = runGate(branch({ filename: "packages/iroh-web/pkg/ghostly_iroh_web.js", additions: 400, deletions: 300, status: "modified" }));
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("changed lines outside lock files (max 600)");
  });
});
