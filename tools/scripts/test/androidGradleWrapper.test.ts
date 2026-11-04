import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
// covers: android.app.boot

/**
 * Every Android build (CI's and `tauri android` on a developer's machine) runs ./gradlew, which runs the committed
 * gradle-wrapper.jar, a binary a diff does not show. The jar must be the one Gradle publishes for the version the
 * wrapper names, and the distribution it downloads must be pinned by its checksum.
 *
 * To bump Gradle: run `./gradlew wrapper --gradle-version <ver> --distribution-type bin` in apps/desktop/gen/android,
 * then set the three values below from Gradle's own files (also listed at https://gradle.org/release-checksums/):
 *   https://services.gradle.org/distributions/gradle-<ver>-wrapper.jar.sha256
 *   https://services.gradle.org/distributions/gradle-<ver>-bin.zip.sha256
 * and put the second one in gradle-wrapper.properties as distributionSha256Sum.
 */
const GRADLE = "9.6.1";
const WRAPPER_JAR_SHA256 = "497c8c2a7e5031f6aa847f88104aa80a93532ec32ee17bdb8d1d2f67a194a9c7";
const DISTRIBUTION_SHA256 = "9c0f7faeeb306cb14e4279a3e084ca6b596894089a0638e68a07c945a32c9e14";

const WRAPPER = join(import.meta.dirname, "../../../apps/desktop/gen/android/gradle/wrapper");
const properties = () =>
  Object.fromEntries(
    readFileSync(join(WRAPPER, "gradle-wrapper.properties"), "utf8")
      .split("\n")
      .filter((line) => line.includes("=") && !line.startsWith("#"))
      .map((line) => [line.slice(0, line.indexOf("=")).trim(), line.slice(line.indexOf("=") + 1).trim().replaceAll("\\", "")]),
  );

it("runs the wrapper jar Gradle publishes for the version it names", () => {
  const jar = createHash("sha256").update(readFileSync(join(WRAPPER, "gradle-wrapper.jar"))).digest("hex");
  expect(jar).toBe(WRAPPER_JAR_SHA256);
});

it("downloads that version's distribution from Gradle, pinned by its checksum", () => {
  const { distributionUrl, distributionSha256Sum } = properties();
  expect(distributionUrl).toBe(`https://services.gradle.org/distributions/gradle-${GRADLE}-bin.zip`);
  expect(distributionSha256Sum).toBe(DISTRIBUTION_SHA256);
});
