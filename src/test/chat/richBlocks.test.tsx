import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MessageBubble } from "../../components/MessageBubble";
import { RichText } from "../../components/rich/RichText";
import { previewText } from "../../lib/chatList";
import type { ChatMessage } from "../../lib/types";
import { renderApp } from "../render";

// covers: chat.rich.blocks, chat.rich.mdlinks, chats.list.rows

/** Sent on 2026-09-25 at 12:00 UTC: history, so no entry animation. */
const SENT = Date.UTC(2026, 8, 25, 12);
const message = (text: string): ChatMessage => ({ id: "m1", text, sender: "peer", timestamp: SENT });
const bubble = (text: string) => renderApp(<MessageBubble message={message(text)} peerPubKey="peer" />);
const text = () => screen.getByTestId("message-text");
/** An item's words, without its marker. */
const body = (li: Element) => li.querySelector(".rich-li-body")!.textContent;

describe("lists", () => {
  it("draw a bullet list as a list, bullets hidden from screen readers", () => {
    bubble("Today:\n- *one*\n- two");
    const list = within(text()).getByRole("list");
    expect(list.tagName).toBe("UL");
    const items = within(list).getAllByRole("listitem");
    expect(items.map(body)).toEqual(["one", "two"]);
    expect(items[0].querySelector("strong")).toHaveTextContent(/^one$/);
    expect(items[0].querySelector(".rich-li-marker")).toHaveAttribute("aria-hidden", "true");
    expect(items[0].querySelector(".rich-li-marker")).toHaveTextContent("•");
    // A list is a block: the text around it is a block too.
    expect(text().tagName).toBe("DIV");
    expect(text().firstChild).toHaveTextContent("Today:");
  });

  it("keep the author's numbers, read as written", () => {
    bubble("3. c\n4) d\n10. j");
    const list = within(text()).getByRole("list");
    expect(list.tagName).toBe("OL");
    const items = within(list).getAllByRole("listitem");
    expect(items.map((li) => li.querySelector(".rich-li-marker")!.textContent)).toEqual(["3.", "4)", "10."]);
    expect(items.map((li) => li.getAttribute("value"))).toEqual(["3", "4", "10"]);
    expect(items[0].querySelector(".rich-li-marker")).not.toHaveAttribute("aria-hidden");
    // Room for the widest marker, so the text lines up.
    expect(list.style.getPropertyValue("--rich-marker")).toBe("3ch");
  });

  it("put a nested list inside its item", () => {
    bubble("- parent\n  - child\n- next");
    const [outer] = within(text()).getAllByRole("list");
    const items = outer.querySelectorAll(":scope > li");
    expect(items).toHaveLength(2);
    const inner = within(items[0] as HTMLElement).getByRole("list");
    expect(within(inner).getByRole("listitem")).toHaveTextContent("child");
  });

  it("stay text inside code", () => {
    bubble("```\n- not a list\n```");
    expect(within(text()).queryByRole("list")).toBeNull();
    expect(text()).toHaveTextContent("- not a list");
  });

  it("leave 1.5 kg alone, and an inline message inline", () => {
    bubble("1.5 kg of flour");
    expect(within(text()).queryByRole("list")).toBeNull();
    expect(text().tagName).toBe("SPAN");
  });
});

describe("quotes and headings", () => {
  it("draw > lines as a quote, lists inside it too", () => {
    bubble("> waiting on review\n> - one comment\nok");
    const quote = screen.getByTestId("rich-quote");
    expect(quote.tagName).toBe("BLOCKQUOTE");
    expect(quote).toHaveTextContent("waiting on review");
    expect(within(quote).getByRole("listitem")).toHaveTextContent("one comment");
    expect(text()).toHaveTextContent(/ok$/);
    expect(quote).not.toHaveTextContent("ok");
  });

  it("leave a > inside a line as text", () => {
    bubble("5 > 3");
    expect(screen.queryByTestId("rich-quote")).toBeNull();
    expect(text()).toHaveTextContent("5 > 3");
  });

  it("draw # lines as headings, without the marks", () => {
    bubble("# Status\n## Done\nbody");
    const headings = screen.getAllByTestId("rich-heading");
    expect(headings.map((h) => [h.dataset.level, h.textContent])).toEqual([["1", "Status"], ["2", "Done"]]);
    expect(text()).not.toHaveTextContent("#");
  });
});

describe("[text](url) links", () => {
  it("show the text, open safely, and name the host on hover", () => {
    bubble("see [the docs](https://ghostly.tools/docs).");
    const link = within(text()).getByRole("link", { name: "the docs" });
    expect(link).toHaveAttribute("href", "https://ghostly.tools/docs");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.getAttribute("title")).toBe("ghostly.tools\nhttps://ghostly.tools/docs");
    expect(link.closest("bdi")).not.toBeNull();
    expect(text()).toHaveTextContent("see the docs.");
  });

  it("show the address when the text names another host", () => {
    bubble("[ghostly.tools](https://evil.example/login)");
    const link = within(text()).getByRole("link");
    expect(link).toHaveTextContent("https://evil.example/login");
    expect(link).toHaveAttribute("dir", "ltr");
    expect(link).toHaveAttribute("data-shows", "url");
    expect(text()).not.toHaveTextContent("ghostly.tools");
  });

  it("show a look-alike host as the browser reads it", () => {
    bubble("[paypal](https://pаypal.com)");
    const link = within(text()).getByRole("link", { name: "paypal" });
    expect(link.getAttribute("title")).toMatch(/^xn--/);
  });

  it("never link anything but http(s)", () => {
    const { container } = bubble("[click](javascript:alert(1)) [x](data:text/html,hi)");
    expect(container.querySelector("a")).toBeNull();
    expect(text()).toHaveTextContent("[click](javascript:alert(1)) [x](data:text/html,hi)");
  });

  it("keep a spoiler in the text covered", () => {
    bubble("[||secret||](https://ghostly.tools)");
    expect(within(text()).getByRole("link")).toHaveTextContent("▒▒▒");
  });
});

describe("chat list previews", () => {
  it("keep • and the author's numbers, and links read as their text", () => {
    expect(previewText("## Plan\n- *a*\n2) b\n> said [the doc](https://ghostly.tools)")).toBe("Plan\n• a\n2) b\nsaid the doc");
  });
});

describe("other places rich text shows", () => {
  it("draw lists in a post too", () => {
    renderApp(<RichText text={"- a\n- b"} testId="post" />);
    expect(within(screen.getByTestId("post")).getAllByRole("listitem")).toHaveLength(2);
  });
});
