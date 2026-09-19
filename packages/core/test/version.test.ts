import { describe, expect, it } from "vitest";
import { compareVersions, isNewerVersion } from "../src";

describe("comparing released versions", () => {
  it("orders by each number in turn", () => {
    expect(isNewerVersion("0.3.5", "0.3.4")).toBe(true);
    expect(isNewerVersion("0.4.0", "0.3.9")).toBe(true);
    expect(isNewerVersion("1.0.0", "0.9.9")).toBe(true);
    expect(isNewerVersion("0.3.4", "0.3.4")).toBe(false);
    expect(isNewerVersion("0.3.3", "0.3.4")).toBe(false);
  });

  it("does not compare the numbers as text", () => {
    expect(isNewerVersion("0.3.10", "0.3.9")).toBe(true);
    expect(isNewerVersion("0.10.0", "0.9.0")).toBe(true);
  });

  it("reads a tag the way a release names it", () => {
    expect(isNewerVersion("v0.3.5", "0.3.4")).toBe(true);
    expect(compareVersions("v0.3.4", "0.3.4")).toBe(0);
  });

  it("ignores what follows the numbers", () => {
    expect(isNewerVersion("0.3.5-beta.1", "0.3.4")).toBe(true);
    expect(isNewerVersion("0.3.4-beta.1", "0.3.4")).toBe(false);
  });

  /** Whatever a published file says, a client only ever moves forward on three numbers. */
  it("never reads anything else as an update", () => {
    for (const latest of ["", "latest", "9", "9.9", "../../etc", "0.3.<script>", "99999999.0.0", "0.3.4.1"]) {
      expect(isNewerVersion(latest, "0.3.4")).toBe(false);
    }
  });
});
