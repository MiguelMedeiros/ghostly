import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// covers: chat.scroll

/**
 * A message that comes while the chat is open plays a short entry (`animate-bubble-in-*`). Kept in effect once it ended
 * (fill `both` or `forwards`), it stayed alive for as long as the row was in the page: one more entry in
 * `document.getAnimations()` per live message in Chromium and WebKit, and a transform per row in Chromium. It ends with
 * nothing left: `backwards` or `none`.
 */
const CSS = readFileSync(join(fileURLToPath(import.meta.url), "../../../index.css"), "utf8");

describe("a message's entry animation", () => {
  for (const side of ["left", "right"]) {
    it(`(${side}) leaves nothing in effect once it ends`, () => {
      const rule = CSS.match(new RegExp(`\\.animate-bubble-in-${side}\\s*\\{([^}]*)\\}`))?.[1];
      expect(rule).toBeDefined();
      const animation = rule!.match(/animation\s*:\s*([^;]+)/)?.[1] ?? "";
      expect(animation).toContain(`bubble-in-${side}`);
      expect(animation.split(/\s+/)).not.toContain("both");
      expect(animation.split(/\s+/)).not.toContain("forwards");
      expect(rule).not.toMatch(/animation-fill-mode\s*:\s*(both|forwards)/);
    });
  }
});
