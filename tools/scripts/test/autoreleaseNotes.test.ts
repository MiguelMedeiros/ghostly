import { describe, expect, it } from "vitest";
import { bump, runGate } from "./autoreleaseGate.ts";

describe("the security autorelease gate's outputs", () => {
  it("gives the version it checked and the changelog section as the notes", () => {
    const run = runGate(bump());
    expect(run.code, run.stderr).toBe(0);
    expect(run.outputs).toEqual({ version: "1.1.7", notes: "- Fix a thing." });
  });

  it("keeps the branch's notes inside the notes, even a line that looks like the end of them", () => {
    // The notes come from the branch the gate does not trust: they must not close their block and set the version.
    const notes = ["- Fix a thing.", "GHOSTLY_EOF", "version=9.0.0", "x<<GHOSTLY_EOF"].join("\n");
    const run = runGate(bump({}, notes));
    expect(run.code, run.stderr).toBe(0);
    expect(run.outputs).toEqual({ version: "1.1.7", notes });
  });
});
