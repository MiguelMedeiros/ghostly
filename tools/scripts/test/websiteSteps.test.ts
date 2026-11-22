import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// guards: #8396

/**
 * The Website job's step names, as the run's page shows them: a step that runs every one of the site's script tests
 * (`npm test` in apps/website) must not carry the name of one of them, or a red link-text test reads as another check
 * failing.
 */
const root = resolve(import.meta.dirname, "../../..");
const ci = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");
const job = ci.match(/^ {2}website:\n([\s\S]*?)(?=^ {2}\S)/m)?.[1] ?? "";
const steps = [...job.matchAll(/^ {6}- name: (.+)\n {8}run: (.+)$/gm)].map(([, name, run]) => ({ name, run }));
const scripts = (JSON.parse(readFileSync(resolve(root, "apps/website/package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;

describe("Website job steps", () => {
  it("the step that runs the site's npm test is named for all of its tests", () => {
    expect(scripts.test.match(/scripts\/[\w-]+\.test\.mjs/g)?.length).toBeGreaterThan(1);
    const step = steps.find((s) => s.run === "npm test");
    expect(step?.name).toBe("Site script tests (npm test)");
  });
});
