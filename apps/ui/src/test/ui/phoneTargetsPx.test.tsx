import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { useRef } from "react";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { JumpToLatest } from "../../components/chat/JumpToLatest";
import { ReactionBar } from "../../components/chat/Reactions";
import { renderApp } from "../render";

// covers: app.mobile-layout, app.accessibility, chat.scroll

/**
 * A phone's 44 px tap target is drawn in px, not rem: at 2.75rem it grows with the browser's text size (66 px at 24 px
 * text, 88 px at 32 px), and the chat's ↓ became an 88 px circle over the newest messages' text and time. happy-dom
 * lays nothing out, so these pin the classes; e2e/web/jump-latest-text-size-phone.spec.ts measures it in Chromium.
 */
const PX = ["max-md:w-[44px]", "max-md:h-[44px]"];
const REM = ["max-md:w-11", "max-md:h-11"];

describe("a phone's icon buttons stay 44 px at any text size", () => {
  it.each([[0, true], [3, false]])("the chat's ↓ (%i new, far %s) is 44 × 44 px on a phone, not 2.75rem", (count, far) => {
    renderApp(<JumpToLatest count={count} far={far} onJump={() => {}} />);
    const jump = screen.getByTestId("jump-latest");
    expect(jump).toHaveClass(...PX);
    for (const rem of REM) expect(jump).not.toHaveClass(rem);
  });

  it("the quick reactions and + are 44 × 44 px on a phone, not 2.75rem", () => {
    function Bar() {
      const anchor = useRef<HTMLSpanElement>(null);
      return <><span ref={anchor} /><ReactionBar open onClose={() => {}} anchorRef={anchor} current="" onReact={() => {}} align="end" /></>;
    }
    renderApp(<Bar />);
    const buttons = [...screen.getAllByTestId("reaction-quick"), screen.getByTestId("reaction-more")];
    expect(buttons.length).toBeGreaterThan(1);
    for (const button of buttons) {
      expect(button).toHaveClass(...PX);
      for (const rem of REM) expect(button).not.toHaveClass(rem);
    }
  });
});

const SRC = join(fileURLToPath(import.meta.url), "../../..");
const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
  entry.isDirectory() ? (entry.name === "test" ? [] : sources(join(dir, entry.name))) : /\.tsx?$/.test(entry.name) ? [join(dir, entry.name)] : []);
const found = (pattern: RegExp, left: ReadonlySet<string> = new Set()) => sources(SRC).flatMap((file) => {
  const name = relative(SRC, file);
  if (left.has(name)) return [];
  return readFileSync(file, "utf8").split("\n").flatMap((line, i) => pattern.test(line) ? [`${name}:${i + 1}: ${line.match(pattern)![0]}`] : []);
});

describe("no phone target in rem that grows with the text size", () => {
  it("no fixed phone box of 2.75rem: a fixed width or height holds an icon, and its 44 px is drawn in px", () => {
    // A box of a fixed size can't hold text that grows, so it is an icon's (↓, ⋮, ×, ⓘ, an emoji): `max-md:w-[44px]`.
    expect(found(/max-md:(?:w|h|size)-11\b/)).toEqual([]);
  });

  it("no phone min width of 2.75rem except on controls that show words (those grow with them)", () => {
    // A min width is an icon button's floor (×, the deck's arrows). Left in rem: Sidebar's New and Join show their
    // words beside the icon, and their large-text layout is set by useLabelsFit; AppDescription's More is words.
    const LEFT = new Set(["components/Sidebar.tsx", "components/apps/AppDescription.tsx"]);
    expect(found(/max-md:min-w-11\b/, LEFT)).toEqual([]);
  });
});
