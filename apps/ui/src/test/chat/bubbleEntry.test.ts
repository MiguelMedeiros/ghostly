import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// covers: chat.scroll

/**
 * A message that comes while the chat is open plays a short entry (`animate-bubble-in-*`). Kept in effect once it ended
 * (fill `both` or `forwards`), it held a transform on the row for as long as the row stayed in the page: each live
 * message cost a transform node in Chromium and a compositing layer of its own in WebKit (the Desktop app), and stayed in
 * `document.getAnimations()`. It ends with nothing left: `backwards` or `none`.
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
