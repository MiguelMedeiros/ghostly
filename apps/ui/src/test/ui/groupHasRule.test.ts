import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// covers: app.composer.typing-cost

/**
 * Tailwind's `group-has-[…]` variant writes a `:has()` rule anchored on every `.group`, and each message row is one:
 * WebKit then pays for every keystroke (and any other change of the page) in proportion to the chat's length. The web
 * e2e (composer-typing-perf) reads the built stylesheet for such a rule, but pull requests do not run it, so this scan
 * says it first. Tailwind reads comments too, so the class may not appear anywhere in a source file, only under test/
 * (which index.css keeps out of the build). What to write instead: `has-[…]` on the element itself, or a sibling rule
 * such as `[[data-x]:focus-visible~*_&]:…`.
 */
const SRC = join(fileURLToPath(import.meta.url), "../../..");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "test" ? [] : sources(path);
    return /\.(tsx?|css|html)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** A class Tailwind would build: the variant, its bracket or name, then a utility. The words alone, in prose, are not one. */
const GROUP_HAS = /group-has-(?:\[\S+\]|[\w-]+)(?:\/[\w-]+)?:\S/;

describe("a :has() rule anchored on .group", () => {
  it("is written nowhere in apps/ui/src/", () => {
    const offenders = sources(SRC).flatMap((file) =>
      readFileSync(file, "utf8").split("\n").flatMap((text, i) => GROUP_HAS.test(text) ? [`${relative(SRC, file)}:${i + 1}`] : []));
    expect(offenders).toEqual([]);
  });

  it("the scan knows the class when it sees it", () => {
    expect(GROUP_HAS.test('className="truncate group-has-[[data-board-card]:focus-visible]:whitespace-normal"')).toBe(true);
    expect(GROUP_HAS.test("group-has-[:focus-visible]:opacity-100")).toBe(true);
    expect(GROUP_HAS.test("group-has-checked/row:underline")).toBe(true);
    expect(GROUP_HAS.test("has-[:focus-visible]:opacity-100 group-hover:opacity-100")).toBe(false);
  });

  it("the Tasks board's card opens its title under keyboard focus by a sibling rule", () => {
    const card = readFileSync(join(SRC, "components/tasks/BoardCard.tsx"), "utf8");
    expect(card).toContain("[[data-board-card]:focus-visible~*_&]:whitespace-normal");
    expect(card).toContain("[[data-board-card]:focus-visible~*_&]:[overflow-wrap:anywhere]");
  });
});
