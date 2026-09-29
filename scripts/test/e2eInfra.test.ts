import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/** A service's lines in e2e/infra/docker-compose.yml, up to the next service (read as text: no YAML parser here). */
function service(name: string): string {
  const lines = readFileSync(resolve(import.meta.dirname, "../../e2e/infra/docker-compose.yml"), "utf8").split("\n");
  const start = lines.indexOf(`  ${name}:`);
  expect(start, `no service ${name}`).toBeGreaterThan(-1);
  const end = lines.findIndex((line, i) => i > start && /^ {2}[a-z0-9-]+:$|^\S/.test(line));
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

describe("the e2e stack (e2e/infra)", () => {
  it("Anvil's memory stays bounded while the stack stays up, and it comes back if it dies", () => {
    const anvil = service("anvil");
    expect(anvil).toContain('"--prune-history"');
    expect(anvil).toMatch(/^ {4}restart: on-failure$/m);
  });
});

describe("the regtest chain (e2e/infra/chain.mjs)", () => {
  it("mines one block when the shared chain's tip is old, so a Lightning node counts as synced; never when it is fresh", async () => {
    const { freshTip, TIP_MAX_AGE_S } = await import("../../e2e/infra/chain.mjs");
    const now = 1_800_000_000_000, mined: number[] = [];
    const mineOne = () => { mined.push(1); };
    expect(freshTip(now, () => now / 1000 - 60, mineOne), "a block a minute old").toBe(false);
    expect(freshTip(now, () => now / 1000 - TIP_MAX_AGE_S, mineOne), "just at the limit").toBe(false);
    expect(mined).toEqual([]);
    expect(freshTip(now, () => now / 1000 - 4 * 24 * 3600, mineOne), "a chain idle for days").toBe(true);
    expect(mined).toEqual([1]);
  });
});
