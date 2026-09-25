import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MessageBubble } from "../../components/MessageBubble";
import type { ChatMessage } from "../../lib/types";
import { renderApp } from "../render";

// covers: app.theme.bubbles

// A real bolt11 for 21u (2,100 sat), from packages/browser/test/uiHelpers.test.ts.
const INVOICE = "lnbc21u1p42mkf2dqqpp56q3d9mfahf0974jqwy0yyfrg7zxksgxk7ufcc084yydhfx43daqqsp59g4z52329g4z52329g4z52329g4z52329g4z52329g4z52329g4q9qrsgqcqzyskhkhqar4dqgqfmarvdttr8x2nrp4txtamfupfftrnn4hmrp7s8ayen7hp2ye58jq8zu65rch9eplpxkhf3pf2nvuynhqxvkw5f7a2vgq486x8x";
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const message = (patch: Partial<ChatMessage> = {}): ChatMessage => ({ id: "m1", text: "hello", sender: "peer", timestamp: 1_700_000_000_000, ...patch });

/**
 * A fixed colour in a bubble reads on one theme's bubble and not another's (dark text on a dark bubble was the
 * light theme's bug). Everything in a bubble takes theme tokens; the chip over a picture is the one exception, since
 * it sits on the picture, not the bubble. How readable the tokens are is measured in e2e/web/bubble-contrast.spec.ts.
 */
const FIXED = /(?:^|\s)(?:[a-z-]+:)*(?:text|bg|fill|stroke|border|decoration)-\[(?:#|hsla?\(|rgba?\()/;

function fixedColours(root: HTMLElement): string[] {
  return [...root.querySelectorAll<Element>("[data-message-bubble], [data-message-bubble] *")]
    .filter((el) => !el.closest("[data-picture-time]"))
    .map((el) => el.getAttribute("class") ?? "")
    .filter((classes) => FIXED.test(classes));
}

describe("MessageBubble: theme colours", () => {
  it.each([
    ["a text with a link", { text: "see https://ghostly.tools/menu first" }],
    ["a text from the contact, with a name", { text: "hello", nick: "Bob" }],
    ["a text of mine, delivered", { text: "hi", sender: "me", delivery: "delivered" }],
    ["a text of mine, not delivered", { text: "hi", sender: "me", delivery: "failed", deliveryError: "no route" }],
    ["a Lightning invoice", { text: `pay me ${INVOICE}` }],
    ["a picture of mine", { text: PNG, sender: "me" }],
    ["a picture from the contact, behind a click", { text: "https://cdn.example.com/cat.jpg" }],
  ] as [string, Partial<ChatMessage>][])("%s: the bubble is the theme's, and nothing in it has a fixed colour", (_, patch) => {
    const { container } = renderApp(<MessageBubble message={message(patch)} peerPubKey="peer" />);
    const bubble = container.querySelector<HTMLElement>("[data-message-bubble]")!;
    const mine = patch.sender === "me";
    expect(bubble.closest("[data-message-row]")).toHaveAttribute("data-sender", mine ? "me" : "peer");
    expect(bubble).toHaveClass(mine ? "bg-sent-bg" : "bg-received-bg");
    expect(bubble.querySelector("svg path")).toHaveClass(mine ? "fill-sent-bg" : "fill-received-bg");
    expect(fixedColours(container)).toEqual([]);
  });

  it("the double-click details take the bubble's colour too", async () => {
    const meta = { dhtKey: "k".repeat(40), dnsRecords: ["a"], relays: [] } as unknown as ChatMessage["meta"];
    const { container, user } = renderApp(<MessageBubble message={message({ meta })} peerPubKey="peer" />);
    await user.dblClick(container.querySelector("[data-message-bubble]")!);
    const panel = await screen.findByTestId("message-details");
    expect(within(panel).getByTestId("message-details-excerpt")).toHaveClass("bg-received-bg");
    expect(container.querySelector("[data-message-bubble]")).toHaveClass("ring-accent");
    expect(fixedColours(container)).toEqual([]);
    expect(fixedColours(panel)).toEqual([]);
  });
});
