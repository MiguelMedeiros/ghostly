import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MessageBubble } from "../../components/MessageBubble";
import { previewText } from "../../lib/chatList";
import type { ChatMessage } from "../../lib/types";
import { renderApp } from "../render";

// covers: chat.rich.format, chat.rich.code, chat.rich.spoiler, chat.rich.blob, chat.rich.time, chats.list.rows

/** Sent on 2026-09-25 at 12:00 UTC: history, so no entry animation. */
const SENT = Date.UTC(2026, 8, 25, 12);
const message = (text: string, patch: Partial<ChatMessage> = {}): ChatMessage => ({ id: "m1", text, sender: "peer", timestamp: SENT, ...patch });
const bubble = (text: string, patch: Partial<ChatMessage> = {}) => renderApp(<MessageBubble message={message(text, patch)} peerPubKey="peer" />);
const text = () => screen.getByTestId("message-text");

describe("formatting", () => {
  it("draws bold, italic, strike and code as elements, without the markers", () => {
    bubble("*bold* _italic_ ~~strike~~ `code`");
    expect(text().querySelector("strong")).toHaveTextContent(/^bold$/);
    expect(text().querySelector("em")).toHaveTextContent(/^italic$/);
    expect(text().querySelector("s")).toHaveTextContent(/^strike$/);
    expect(text().querySelector("code")).toHaveTextContent(/^code$/);
    expect(text()).toHaveTextContent("bold italic strike code");
  });

  it("never renders markup from the message", () => {
    const { container } = bubble('<b>not bold</b> <img src=x onerror="alert(1)"> *<i>still text</i>*');
    expect(container.querySelector("b, i, img")).toBeNull();
    expect(text()).toHaveTextContent('<b>not bold</b> <img src=x onerror="alert(1)"> <i>still text</i>');
    expect(text().querySelector("strong")).toHaveTextContent("<i>still text</i>");
  });

  it("keeps links, inside formatting too", () => {
    bubble("*read https://ghostly.tools/docs.*");
    const link = within(text().querySelector("strong")!).getByRole("link");
    expect(link).toHaveAttribute("href", "https://ghostly.tools/docs");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("stays one inline line when there is no block, so the time sits at its end", () => {
    bubble("*hi*");
    expect(text().tagName).toBe("SPAN");
  });

  it("leaves big emoji, pictures and money as they were", () => {
    const { container, unmount } = bubble("👻");
    expect(container.querySelector(".text-\\[42px\\]")).toHaveTextContent("👻");
    unmount();
    bubble("https://media.giphy.com/media/abc123/200w");
    expect(screen.queryByTestId("message-text")).toBeNull();
  });
});

describe("spoilers", () => {
  it("hide their text from sight and from screen readers until tapped", async () => {
    const { user } = bubble("the butler did it: ||it was the gardener||");
    const spoiler = screen.getByRole("button", { name: "Hidden text. Tap to show it" });
    expect(spoiler.firstElementChild).toHaveAttribute("aria-hidden", "true");
    await user.click(spoiler);
    expect(screen.queryByRole("button", { name: "Hidden text. Tap to show it" })).toBeNull();
    expect(screen.getByTestId("rich-spoiler")).toHaveAttribute("data-shown");
    expect(screen.getByTestId("rich-spoiler").querySelector("[aria-hidden]")).toBeNull();
    expect(screen.getByTestId("rich-spoiler")).toHaveTextContent("it was the gardener");
  });

  it("open from the keyboard", async () => {
    const { user } = bubble("||secret||");
    await user.tab();
    expect(screen.getByTestId("rich-spoiler")).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(screen.getByTestId("rich-spoiler")).toHaveAttribute("data-shown");
  });

  it("keep a link inside unreachable until shown", async () => {
    const { user } = bubble("||https://x.example/secret||");
    expect(screen.getByTestId("rich-spoiler").querySelector("[inert]")).not.toBeNull();
    await user.click(screen.getByTestId("rich-spoiler"));
    expect(screen.getByRole("link")).toHaveAttribute("href", "https://x.example/secret");
  });
});

describe("code blocks", () => {
  it("show the code with its language, highlighted once the highlighter loads", async () => {
    bubble("look:\n```ts\nconst answer: number = 42;\n```\nnice");
    const block = screen.getByTestId("rich-codeblock");
    expect(block).toHaveAttribute("data-lang", "ts");
    expect(block).toHaveTextContent("ts");
    expect(block.querySelector("pre")).toHaveTextContent("const answer: number = 42;");
    await waitFor(() => expect(block).toHaveAttribute("data-highlighted"));
    expect(block.querySelector(".hljs-keyword")).toHaveTextContent("const");
    expect(block.querySelector(".hljs-number")).toHaveTextContent("42");
    // A block makes the text a block too; the words around it stay.
    expect(text().tagName).toBe("DIV");
    expect(text()).toHaveTextContent(/^look:.*nice$/);
  });

  it("stay plain for a language the build does not know, or none", async () => {
    bubble("```brainfuck\n+[-->-[>>+>-----<<]<--<---]>-.\n```\n```\nplain\n```");
    const [unknown, none] = screen.getAllByTestId("rich-codeblock");
    expect(none).toHaveTextContent("Code");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(unknown).not.toHaveAttribute("data-highlighted");
    expect(unknown.querySelector("pre")).toHaveTextContent("+[-->-[>>+>-----<<]<--<---]>-.");
  });

  it("copy their code", async () => {
    const { user } = bubble("```py\nprint('hi')\n```");
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    await user.click(screen.getByTestId("rich-codeblock-copy"));
    expect(writeText).toHaveBeenCalledWith("print('hi')");
    expect(screen.getByTestId("rich-codeblock-copy")).toHaveTextContent("Copied");
  });

  it("pretty-print a message that is JSON", () => {
    bubble('{"amount":21,"memo":"coffee"}');
    const block = screen.getByTestId("rich-codeblock");
    expect(block).toHaveAttribute("data-lang", "json");
    expect(block.querySelector("pre")!.textContent).toBe('{\n  "amount": 21,\n  "memo": "coffee"\n}');
  });
});

describe("long blobs", () => {
  const KEY = "A1b2".repeat(30);

  it("fold to a line with Show all and Copy", async () => {
    const { user } = bubble(`my key ${KEY}`);
    const blob = screen.getByTestId("rich-blob");
    const toggle = within(blob).getByTestId("rich-blob-toggle");
    expect(toggle).toHaveTextContent("Show all");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(blob).toHaveAttribute("data-open");
    expect(toggle).toHaveTextContent("Show less");
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    await user.click(within(blob).getByTestId("rich-blob-copy"));
    expect(writeText).toHaveBeenCalledWith(KEY);
  });
});

describe("times", () => {
  it("show the reader's local time on hover (title) and on a tap", async () => {
    const { user } = bubble("standup at 14:00 UTC");
    const time = screen.getByTestId("rich-time");
    const button = within(time).getByRole("button", { name: "14:00 UTC" });
    const local = new Date(Date.UTC(2026, 8, 25, 14)).toLocaleString([], { hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
    expect(button).toHaveAttribute("title", `${local} your time`);
    expect(time.querySelector("time")).toHaveAttribute("datetime", "2026-09-25T14:00:00.000Z");
    expect(screen.queryByTestId("rich-time-local")).toBeNull();
    await user.click(button);
    expect(screen.getByTestId("rich-time-local")).toHaveTextContent(`(${local} your time)`);
  });

  it("leaves a time without a zone alone", () => {
    bubble("see you at 14:00");
    expect(screen.queryByTestId("rich-time")).toBeNull();
  });

  it("translates the local-time label", () => {
    renderApp(<MessageBubble message={message("at 14:00 UTC")} peerPubKey="peer" />, { language: "pt" });
    expect(screen.getByRole("button", { name: "14:00 UTC" }).getAttribute("title")).toMatch(/no seu horário$/);
  });
});

describe("chat list previews", () => {
  it("read without markers, and never show a spoiler", () => {
    expect(previewText("*Hi* _there_ ~~old~~ `x` ||the ending||")).toBe("Hi there old x ▒▒▒");
    expect(previewText("```ts\nconst a = 1;\n```")).toBe("const a = 1;");
  });

  it("still name money", () => {
    expect(previewText("cashuAeyJ0b2tlbiI6W3sibWludCI6Imh0dHBzOi8vbWludCJ9XX0")).toBe("⚡ Ecash");
  });
});
