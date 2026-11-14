import { expect, test } from "@playwright/test";

/**
 * A time budget of a test tagged @perf: the measured value is kept on the test as a `perf` annotation (the nightly
 * E2E (perf) job puts every one in its summary and in perf.json), then held under its bound.
 *
 * A test whose pass hangs on milliseconds or frame times is tagged @perf: the config leaves those out of every run but
 * the nightly one (E2E_PERF=1), as shared runners fail them at random. What the test checks besides (rows in the page,
 * commits, writes) stays in a twin without the tag.
 */
export function budget(name: string, value: number, below: number, unit = "ms"): void {
  test.info().annotations.push({ type: "perf", description: JSON.stringify({ name, value, below, unit }) });
  expect(value, `${name} (${unit})`).toBeLessThan(below);
}
