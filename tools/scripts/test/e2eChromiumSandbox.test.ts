import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, it, vi } from "vitest";

const ROOT = join(import.meta.dirname, "../../..");

/** Every .ts/.mjs file under a folder, node_modules and test output left out. */
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return /^(node_modules|test-results)$/.test(entry.name) ? [] : files(path);
    return /\.(ts|mjs)$/.test(entry.name) ? [path] : [];
  });
}

/** The Chromium suites' configs and specs: Firefox and WebKit have no such switch. */
const SOURCES = [
  ...files(join(ROOT, "e2e")).filter((path) => !/playwright\.(firefox|webkit)\.config\.ts$/.test(path)),
  ...files(join(ROOT, "apps/website/e2e")),
  ...files(join(ROOT, "apps/website/scripts/capture")),
];

/**
 * Playwright launches Chromium with `--no-sandbox` unless `chromiumSandbox: true` is passed. A launch inside a test takes
 * the worker's launchOptions, so what has to carry it is every `launchOptions` a config or a spec sets (a spec's replaces
 * the config's whole object) and every launch outside a test (a `beforeAll`'s, whose own options are all it gets).
 */
it("every Chromium launch the suites set up keeps the sandbox on", () => {
  const missing: string[] = [];
  let seen = 0;
  for (const path of SOURCES) {
    const lines = readFileSync(path, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*\*)/.test(line)) return;
      if (!/\blaunchOptions(: |\s*=\s*)\{|\bchromium\.launch(PersistentContext)?\(/.test(line)) return;
      seen++;
      // The option sits on the line itself or in the object's first lines.
      if (!lines.slice(i, i + 3).some((next) => next.includes("chromiumSandbox"))) missing.push(`${relative(ROOT, path)}:${i + 1}`);
    });
  }
  expect(missing).toEqual([]);
  expect(seen).toBeGreaterThan(15);
});

it("the switch is on unless E2E_CHROMIUM_SANDBOX=0", async () => {
  const saved = process.env.E2E_CHROMIUM_SANDBOX;
  const load = async (value: string | undefined) => {
    if (value === undefined) delete process.env.E2E_CHROMIUM_SANDBOX;
    else process.env.E2E_CHROMIUM_SANDBOX = value;
    vi.resetModules();
    return (await import("../../../e2e/support/chromiumSandbox")).CHROMIUM_SANDBOX;
  };
  try {
    expect(await load(undefined)).toBe(true);
    expect(await load("1")).toBe(true);
    expect(await load("0")).toBe(false);
  } finally {
    if (saved === undefined) delete process.env.E2E_CHROMIUM_SANDBOX;
    else process.env.E2E_CHROMIUM_SANDBOX = saved;
  }
});
