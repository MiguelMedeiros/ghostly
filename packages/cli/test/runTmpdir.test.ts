import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { expect, test } from "vitest";
import { profilePaths } from "../src/profiles";
import { home } from "./support/cli";

// The profile homes tests make go in the run's own temp folder, which the run removes at its end (test/support/build.ts):
// left in /tmp, they were hundreds of MB a run.
test("a test's temp folders are in the run's own folder", () => {
  expect(basename(tmpdir())).toMatch(/^cli-/);
  expect(dirname(home("run-tmpdir"))).toBe(tmpdir());
});

// A test's fake daemon listens on the profile's socket path itself: past 100 bytes it would be in a runtime folder the
// fake never makes, and the test would hang. The longest home name a test uses today is 28 characters. A long system
// temp folder (macOS's) is past it already.
test.skipIf(tmpdir().length > "/tmp/cli-XXXXXX".length)("the run's folder leaves a long-named test home its socket in the profile's folder", () => {
  const dir = home("x".repeat(32));
  expect(profilePaths(dir, "default").socket).toBe(join(dir, "profiles", "default", "daemon.sock"));
});
