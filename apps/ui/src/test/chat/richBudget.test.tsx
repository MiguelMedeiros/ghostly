import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RichText } from "../../components/rich/RichText";
import { renderApp } from "../render";

// covers: chat.rich.blocks

/*
 * agents#1749: a contact's text within the 16 KiB cap, written as marker soup, drew thousands of elements and Tab stops
 * in its bubble: 5,333 elements for `||a||` x2666, 12,002 for "- a" x4000, 7,109 for "1:00 UTC" x1777. A chat holding a
 * few dozen of them took 1.5-2.1 s of long tasks at every open and 300-500 MB of heap.
 */

/** Sent on 2026-09-25 at 12:00 UTC. */
const SENT = Date.UTC(2026, 8, 25, 12);
const SOUPS: Record<string, string> = {
  spoilers: "||a|| ".repeat(2666),
  list: "- a\n".repeat(4000),
  times: "1:00 UTC ".repeat(1777),
  links: "https://a.co ".repeat(1230),
  code: "`a` ".repeat(4000),
  mixed: "*b* _i_ ||s|| `c` https://a.co 1:00 UTC\n".repeat(400),
};

const draw = (text: string) => {
  const view = renderApp(<RichText text={text} sentAt={SENT} testId="rich" />);
  const root = screen.getByTestId("rich");
  const elements = root.querySelectorAll("*").length;
  const stops = root.querySelectorAll("a[href], button, [tabindex]:not([tabindex='-1'])").length;
  return { view, root, elements, stops };
};

describe("a message's formatting on screen", () => {
  for (const [name, text] of Object.entries(SOUPS)) it(`is bounded whatever the markers: ${name}, ${new TextEncoder().encode(text).length} bytes`, () => {
    const { view, elements, stops, root } = draw(text);
    console.log(`RICH ${name}: ${elements} elements, ${stops} stops`);
    expect(elements).toBeLessThanOrEqual(700);
    expect(stops).toBeLessThanOrEqual(60);
    // Nothing is lost: what is past the budget reads as text, a spoiler still covered.
    const count = (what: string) => root.textContent!.split(what).length - 1;
    if (name === "spoilers") expect(count("a") + count("▒")).toBe(2666);
    if (name === "spoilers") expect(count("▒")).toBeGreaterThan(2000);
    if (name === "list") expect(count("a")).toBe(4000);
    if (name === "code") expect(count("a")).toBe(4000);
    if (name === "links") expect(count("a.co")).toBe(1230);
    view.unmount();
  });

  it("leaves a message with ordinary formatting as it was", () => {
    const { root } = draw("*Hi* _there_, see https://ghostly.chat at 1:00 UTC:\n- one\n- ||two||\n`code`");
    expect(root.querySelector("strong")).toHaveTextContent("Hi");
    expect(root.querySelectorAll("[data-testid=rich-spoiler]")).toHaveLength(1);
    expect(root.querySelectorAll("li")).toHaveLength(2);
    expect(root.querySelector("code")).toHaveTextContent("code");
    expect(root.textContent).not.toContain("▒");
    expect(screen.queryByTestId("rich-rest")).toBeNull();
  });
});
