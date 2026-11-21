import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../../..");
const workflow = (file: string) => readFileSync(join(ROOT, ".github/workflows", file), "utf8");

/**
 * Home's version link (apps/ui/src/components/HomeProjectLinks.tsx) opens the release's page only in a build that
 * carries VITE_RELEASE_TAG for the version it runs. release.yml hands its tag to every app build that shows the link:
 * the Desktop builds and the Android app's.
 */
it("release.yml hands its tag to the Desktop builds and to android.yml's build", () => {
  const release = workflow("release.yml");
  expect(release).toMatch(/\n {2}build-tauri:\n(?: {4}.*\n|\n)*? {4}env:\n(?: {6}.*\n)*? {6}VITE_RELEASE_TAG: \$\{\{ inputs\.tag \|\| github\.ref_name \}\}\n/);
  expect(release).toMatch(/uses: \.\/\.github\/workflows\/android\.yml\n {4}with:\n(?: {6}.*\n)*? {6}release_tag: \$\{\{ inputs\.tag \|\| github\.ref_name \}\}\n/);

  const android = workflow("android.yml");
  expect(android).toMatch(/\n {6}release_tag:\n/);
  expect(android).toContain("          VITE_RELEASE_TAG: ${{ inputs.release_tag }}\n");
});
