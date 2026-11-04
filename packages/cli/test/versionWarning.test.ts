import { describe, expect, it } from "vitest";
import { compareReleases, restartWarning, versionWarning } from "../src/main";
// covers: headless.daemon, headless.cli

/** Which side of a daemon and a command runs the newer release, and what each is told to do about it. */
describe("the daemon's version against the command's", () => {
  it("an older daemon: `ghostly daemon restart` runs this command's release", () => {
    const warning = versionWarning("1.4.5", "1.5.0");
    expect(warning).toBe("ghostly: the daemon runs 1.4.5 and this command is 1.5.0: `ghostly daemon restart` runs the new code");
  });

  it("a newer daemon: the command is the old one, upgrade the CLI, and no restart (it would start the older release)", () => {
    const warning = versionWarning("1.5.0", "1.4.5");
    expect(warning).toContain("the daemon runs 1.5.0 and this command is 1.4.5");
    expect(warning).toContain("older than the daemon");
    expect(warning).toContain("npm install -g @ghostlytools/cli");
    expect(warning).not.toContain("daemon restart");
  });

  it("the same release says nothing; nor does a daemon that gave no version", () => {
    expect(versionWarning("1.5.0", "1.5.0")).toBeNull();
    expect(versionWarning("v1.5.0", "1.5.0")).toBeNull();
    expect(versionWarning("1.5.0+build.7", "1.5.0")).toBeNull();
    expect(versionWarning(undefined, "1.5.0")).toBeNull();
    expect(versionWarning(150, "1.5.0")).toBeNull();
  });

  it("orders by number, not by text: 1.10.0 is newer than 1.9.0", () => {
    expect(versionWarning("1.10.0", "1.9.0")).toContain("npm install -g @ghostlytools/cli");
    expect(versionWarning("1.9.0", "1.10.0")).toContain("`ghostly daemon restart` runs the new code");
    expect(versionWarning("2.0.0", "1.99.99")).not.toContain("daemon restart");
  });

  it("a prerelease is older than its release and newer than the one before", () => {
    expect(versionWarning("1.5.0-beta.1", "1.5.0")).toContain("`ghostly daemon restart` runs the new code");
    expect(versionWarning("1.5.0", "1.5.0-beta.1")).not.toContain("daemon restart");
    expect(versionWarning("1.5.0-beta.1", "1.4.5")).not.toContain("daemon restart");
    expect(versionWarning("1.5.0-beta.2", "1.5.0-beta.10")).toContain("`ghostly daemon restart` runs the new code");
    expect(versionWarning("1.5.0-rc.1", "1.5.0-beta.3")).not.toContain("daemon restart");
  });

  it("a version that is not one names both and gives no advice it cannot back", () => {
    const warning = versionWarning("dev", "1.5.0");
    expect(warning).toContain("the daemon runs dev and this command is 1.5.0");
    expect(warning).not.toContain("new code");
    expect(warning).not.toContain("npm install");
  });

  it("compares releases in semver order", () => {
    expect(Math.sign(compareReleases("1.10.0", "1.9.0")!)).toBe(1);
    expect(Math.sign(compareReleases("1.4.5", "1.5.0")!)).toBe(-1);
    expect(compareReleases("v1.5.0", "1.5.0")).toBe(0);
    expect(Math.sign(compareReleases("1.5.0-alpha", "1.5.0-alpha.1")!)).toBe(-1);
    expect(Math.sign(compareReleases("1.5.0-1", "1.5.0-alpha")!)).toBe(-1);
    expect(compareReleases("1.5", "1.5.0")).toBeNull();
    expect(compareReleases("", "1.5.0")).toBeNull();
  });
});

describe("daemon restart that starts an older release than it stopped", () => {
  it("says so on stderr, and how to go back", () => {
    const warning = restartWarning("1.5.0", "1.4.5");
    expect(warning).toContain("the daemon ran 1.5.0 and this restart started 1.4.5, an older release");
    expect(warning).toContain("npm install -g @ghostlytools/cli");
  });

  it("says nothing for the same release, a newer one, or no daemon before", () => {
    expect(restartWarning("1.5.0", "1.5.0")).toBeNull();
    expect(restartWarning("1.4.5", "1.5.0")).toBeNull();
    expect(restartWarning(null, "1.5.0")).toBeNull();
    expect(restartWarning("dev", "1.5.0")).toBeNull();
  });
});
