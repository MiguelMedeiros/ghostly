import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "@tailwindcss/node";
import { describe, expect, it } from "vitest";
import { MOBILE_QUERY } from "../../hooks/useIsMobile";

// covers: app.mobile-layout, app.responsive

/*
 * The app picks its layout in JS with px queries (`MOBILE_QUERY`, the phone header's), and its own CSS with px queries
 * too. Tailwind's breakpoints were in rem (`md` = 48rem), and a rem in a media query is the browser's font size: with
 * Chrome's font at Very large (24px) a 1024px window was under `md` but not under `MOBILE_QUERY`, so it showed the chat
 * list and the chat side by side with the phone's CSS on both (a Back arrow beside the list, the connection panel as
 * a phone sheet over both panes). Every viewport width the CSS asks is in px, and `md` is where `MOBILE_QUERY` ends.
 */
const SRC = join(fileURLToPath(import.meta.url), "../../..");

/** The `@media` conditions of index.css built with `candidates`. */
const mediaOf = async (candidates: string[]) => {
  const compiler = await compile(readFileSync(join(SRC, "index.css"), "utf8"), { base: SRC, onDependency() {} });
  return [...compiler.build(candidates).matchAll(/@media ([^{]*)\{/g)].map((m) => m[1].trim());
};

describe("the layout's breakpoints", () => {
  it("are in px, as the JS layout queries are", async () => {
    const media = await mediaOf(["max-sm:hidden", "sm:flex", "max-md:hidden", "md:flex", "max-lg:hidden", "lg:flex", "xl:flex", "2xl:flex"]);
    const breakpoints = ["(width < 640px)", "(width >= 640px)", "(width < 768px)", "(width >= 768px)", "(width < 1024px)", "(width >= 1024px)", "(width >= 1280px)", "(width >= 1536px)"];
    expect(media).toEqual(expect.arrayContaining(breakpoints));
    // A very narrow screen's own rule (a group's pictures gone under 22rem) may follow the font; a layout's may not.
    const remWidths = media.filter((query) => [...query.matchAll(/width[^)]*?([\d.]+)rem/g)].some((m) => Number(m[1]) >= 30));
    expect(remWidths).toEqual([]);
  });

  it("put md where the JS phone layout ends", async () => {
    const phoneEnds = Number(MOBILE_QUERY.match(/max-width: (\d+)px/)?.[1]) + 1;
    expect(await mediaOf(["max-md:hidden", "md:flex"])).toEqual(expect.arrayContaining([`(width < ${phoneEnds}px)`, `(width >= ${phoneEnds}px)`]));
  });
});
