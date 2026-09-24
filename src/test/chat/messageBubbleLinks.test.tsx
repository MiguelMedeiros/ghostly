import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MessageBubble } from "../../components/MessageBubble";
import { renderApp } from "../render";

// covers: chat.paired.links

// A link ends where the sentence around it takes over: its trailing punctuation, and a closing bracket it did
// not open, stay text. Before, "Read https://ghostly.tools/docs." linked to ".../docs." — a page that does not exist.
describe("MessageBubble links", () => {
  it.each([
    ["a full stop", "Read https://ghostly.tools/docs.", "https://ghostly.tools/docs"],
    ["a comma", "See https://ghostly.tools/docs, then reply", "https://ghostly.tools/docs"],
    ["brackets", "the docs (https://ghostly.tools/docs) say so", "https://ghostly.tools/docs"],
    ["a question mark and a quote", 'Did you read "https://ghostly.tools/docs"?', "https://ghostly.tools/docs"],
    ["a bracket the link opened", "https://en.wikipedia.org/wiki/Ghost_(disambiguation)", "https://en.wikipedia.org/wiki/Ghost_(disambiguation)"],
    ["a query string", "https://ghostly.tools/docs?page=2&x=1.", "https://ghostly.tools/docs?page=2&x=1"],
  ])("handles %s", (_, text, href) => {
    renderApp(<MessageBubble message={{ id: "m1", text, sender: "peer", timestamp: 1_700_000_000_000 }} />);
    expect(screen.getByRole("link")).toHaveAttribute("href", href);
    expect(screen.getByRole("link")).toHaveTextContent(href);
  });

  it("keeps the punctuation it leaves out as text", () => {
    const { container } = renderApp(<MessageBubble message={{ id: "m1", text: "Read https://ghostly.tools/docs.", sender: "peer", timestamp: 1_700_000_000_000 }} />);
    expect(container).toHaveTextContent("Read https://ghostly.tools/docs.");
  });
});
