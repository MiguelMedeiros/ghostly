import { act, fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MessageBubble } from "../../components/MessageBubble";
import { publicKeyLabel } from "../../lib/publicKeyLabel";
import type { ChatMessage } from "../../lib/types";
import { fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: chat.paired.links, chat.paired.image-links, chat.paired.receipts, chat.paired.delete-message, chat.paired.message-details, chat.paired.join-notice, payments.lightning.invoice-card, payments.cashu.token-card

// A real bolt11 for 21u (2,100 sat), from packages/browser/test/uiHelpers.test.ts.
const INVOICE = "lnbc21u1p42mkf2dqqpp56q3d9mfahf0974jqwy0yyfrg7zxksgxk7ufcc084yydhfx43daqqsp59g4z52329g4z52329g4z52329g4z52329g4z52329g4z52329g4q9qrsgqcqzyskhkhqar4dqgqfmarvdttr8x2nrp4txtamfupfftrnn4hmrp7s8ayen7hp2ye58jq8zu65rch9eplpxkhf3pf2nvuynhqxvkw5f7a2vgq486x8x";
const TOKEN = "cashuB" + "o".repeat(40);
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/** An old message (history: no entry animation) from the contact, unless the patch says otherwise. */
const message = (patch: Partial<ChatMessage> = {}): ChatMessage => ({ id: "m1", text: "hello", sender: "peer", timestamp: 1_700_000_000_000, ...patch });

function bubble(patch: Partial<ChatMessage> = {}, props: Partial<Parameters<typeof MessageBubble>[0]> = {}) {
  return renderApp(<MessageBubble message={message(patch)} peerPubKey="peer" {...props} />);
}

const image = (container: HTMLElement) => container.querySelector("img");

describe("MessageBubble: pictures", () => {
  it.each([
    ["an inline PNG", PNG],
    ["an inline JPEG", "data:image/jpeg;base64,/9j/4AAQSkZJRg=="],
    ["an inline GIF", "data:image/gif;base64,R0lGODlhAQABAAAAACw="],
    ["an inline WebP", "data:image/webp;base64,UklGRhoAAABXRUJQ"],
    ["a Giphy GIF", "https://media2.giphy.com/media/xT9IgG50Fb7Mi0prBC/giphy.gif"],
    ["a Giphy picture without an image extension", "https://media.giphy.com/media/abc123/200w"],
  ])("loads %s from the contact by itself", (_, url) => {
    const { container } = bubble({ text: url });
    expect(image(container)).toHaveAttribute("src", url);
    expect(screen.queryByTestId("image-reveal")).not.toBeInTheDocument();
  });

  it("loads a Wayback Machine GIF by itself, drawn as pixel art", () => {
    const url = "https://web.archive.org/web/20091027000000/http://www.geocities.com/area51/dancing.gif";
    const { container } = bubble({ text: url });
    expect(image(container)).toHaveAttribute("src", url);
    expect(image(container)!.getAttribute("style")).toContain("pixelated");
  });

  it("does not draw an ordinary picture as pixel art", () => {
    const { container } = bubble({ text: PNG });
    expect(image(container)!.getAttribute("style") ?? "").not.toContain("pixelated");
  });

  it("keeps any other picture from the contact behind a click, naming its host", async () => {
    const url = "https://cdn.example.com/photos/cat.jpg?size=large";
    const { user, container } = bubble({ text: url });
    // Loading it would tell cdn.example.com this device's address.
    expect(image(container)).toBeNull();
    const reveal = screen.getByTestId("image-reveal");
    expect(reveal).toHaveTextContent("Show picture · cdn.example.com");
    await user.click(reveal);
    expect(image(container)).toHaveAttribute("src", url);
    expect(screen.queryByTestId("image-reveal")).not.toBeInTheDocument();
  });

  it("loads my own pictures from anywhere", () => {
    const url = "https://cdn.example.com/photos/cat.png";
    const { container } = bubble({ text: url, sender: "me" });
    expect(image(container)).toHaveAttribute("src", url);
    expect(screen.queryByTestId("image-reveal")).not.toBeInTheDocument();
  });

  it("treats an SVG data URL as text, never as a picture", () => {
    const svg = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=";
    const { container } = bubble({ text: svg, sender: "me" });
    expect(image(container)).toBeNull();
    expect(screen.getByText(svg)).toBeInTheDocument();
  });

  it("treats a picture over plain http as a link", () => {
    const url = "http://example.com/cat.png";
    const { container } = bubble({ text: url });
    expect(image(container)).toBeNull();
    expect(screen.queryByTestId("image-reveal")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: url })).toHaveAttribute("href", url);
  });

  it("falls back to the text when a picture does not load", () => {
    const url = "https://media.giphy.com/media/gone/giphy.gif";
    const { container } = bubble({ text: url });
    fireEvent.error(image(container)!);
    expect(image(container)).toBeNull();
    expect(screen.getByRole("link", { name: url })).toHaveAttribute("href", url);
  });
});

describe("MessageBubble: money in a message", () => {
  it("shows a Lightning invoice as a card to pay", () => {
    bubble({ text: INVOICE });
    const card = screen.getByTestId("invoice-bubble");
    expect(card).toHaveTextContent("Lightning invoice");
    expect(within(card).getByTestId("money-amount")).toHaveTextContent("2,100");
  });

  it("keeps the words around an invoice above its card", () => {
    bubble({ text: `pay me please ${INVOICE}` });
    expect(screen.getByText("pay me please")).toBeInTheDocument();
    expect(screen.getByTestId("invoice-bubble")).toBeInTheDocument();
  });

  it("shows an ecash token as a card, once the wallet read it", async () => {
    fakeEngine.on("walletInspectCashu", () => ({ inspection: { kind: "token", amount: 100, unit: "sat", mint: "https://mint.example.com", accepted: true } }));
    const { engine } = bubble({ text: `here you go ${TOKEN}` });
    const card = await screen.findByTestId("cashu-token-bubble");
    expect(card).toHaveTextContent("Mint: mint.example.com");
    expect(engine.callsTo("walletInspectCashu")).toEqual([{ text: TOKEN }]);
  });

  it("leaves a payment's text to its payment bubble", () => {
    bubble({ text: INVOICE, paymentId: "pay-9" });
    expect(screen.queryByTestId("invoice-bubble")).not.toBeInTheDocument();
    // No such payment in the wallet: the bubble falls back to the text it carried.
    expect(screen.getByText(INVOICE)).toBeInTheDocument();
  });

  it("leaves a file's caption alone", () => {
    // Still arriving: the bubble does not look for the bytes yet.
    fakeEngine.update({ transfers: { "file-1": { state: "transferring", transferred: 5, size: 10 } } });
    bubble({ text: INVOICE, file: { id: "file-1", name: "invoice.txt", size: 10, mime: "text/plain" } });
    expect(screen.getByTestId("file-bubble")).toHaveTextContent("invoice.txt");
    expect(screen.queryByTestId("invoice-bubble")).not.toBeInTheDocument();
  });
});

describe("MessageBubble: text", () => {
  it("turns web addresses into links that open apart from the app", () => {
    bubble({ text: "docs at https://ghostly.tools/docs and http://example.org/a?b=1 too" });
    for (const href of ["https://ghostly.tools/docs", "http://example.org/a?b=1"]) {
      const link = screen.getByRole("link", { name: href });
      expect(link).toHaveAttribute("href", href);
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
    }
    expect(screen.getByText(/docs at/)).toHaveTextContent("docs at https://ghostly.tools/docs and http://example.org/a?b=1 too");
  });

  it("shows a message of only emoji big", () => {
    bubble({ text: "🎉👻" });
    expect(screen.getByText("🎉👻")).toHaveClass("text-[42px]");
  });

  it.each([["words with an emoji", "nice 🎉"], ["too many emoji", "🎉🎉🎉🎉🎉🎉🎉"]])("shows %s at the normal size", (_, text) => {
    bubble({ text });
    expect(screen.getByText(text)).not.toHaveClass("text-[42px]");
  });

  it("names the contact on their messages, from the message or the chat", () => {
    const { rerender } = bubble({ text: "hi", nick: "Alice" }, { peerNick: "Bob" });
    expect(screen.getByText("~Alice")).toBeInTheDocument();
    rerender(<MessageBubble message={message({ text: "hi" })} peerNick="Bob" />);
    expect(screen.getByText("~Bob")).toBeInTheDocument();
    rerender(<MessageBubble message={message({ text: "hi", sender: "me" })} peerNick="Bob" />);
    expect(screen.queryByText("~Bob")).not.toBeInTheDocument();
  });

  it("shows the technical details on a double click, when there are any", async () => {
    const { user } = bubble({ text: "hi", sender: "me", meta: { dhtKey: "k".repeat(40), encryptedPayloadLength: 10, dnsRecords: ["a", "b"] } }, { peerAck: 1_800_000_000_000 });
    await user.dblClick(screen.getByText("hi"));
    expect(screen.getByText(/ACKed \(1800000000000\)/)).toBeInTheDocument();
    expect(screen.getByText("outbound")).toBeInTheDocument();
    await user.dblClick(screen.getByText("hi"));
    expect(screen.queryByText("outbound")).not.toBeInTheDocument();
  });
});

describe("MessageBubble: system lines", () => {
  it("says who joined the chat, by a short key", () => {
    const key = "yb1q3k9mfahf0974jqwy0yyfrg7zxksgxk7ufcc0";
    bubble({ sender: "system", text: "", systemEvent: { type: "join", pubKey: key } });
    expect(screen.getByText(publicKeyLabel(key))).toBeInTheDocument();
    expect(screen.getByText(/joined the chat/)).toBeInTheDocument();
  });

  it.each([
    ["call_missed", "Missed call", true],
    ["call_rejected", "Call declined", true],
    ["call_ended", "Call ended", false],
    ["call_received", "Incoming call", false],
  ] as const)("marks a %s event as missed or not", (type, text, missed) => {
    bubble({ sender: "system", text, callEvent: { type } });
    const pill = screen.getByText(text).parentElement!;
    expect(pill.classList.contains("bg-danger/10")).toBe(missed);
  });

  it.each([[65_000, "(1m 5s)"], [42_900, "(42s)"], [600_000, "(10m 0s)"]])("shows a call that lasted %i ms as %s", (duration, shown) => {
    bubble({ sender: "system", text: "Call ended", callEvent: { type: "call_ended", duration } });
    expect(screen.getByText(shown)).toBeInTheDocument();
  });

  it("shows no length for a call that never started", () => {
    bubble({ sender: "system", text: "Missed call", callEvent: { type: "call_missed", duration: 0 } });
    expect(screen.getByText("Missed call").parentElement).not.toHaveTextContent("(");
  });

  it("lets a system line be deleted too", () => {
    bubble({ sender: "system", text: "Call ended", callEvent: { type: "call_ended" } }, { onDelete: () => {} });
    expect(screen.getByRole("button", { name: "Delete message" })).toBeInTheDocument();
  });
});

describe("MessageBubble: delivery", () => {
  it.each([
    ["sending", "Sending…"],
    ["sent", "Sent · waiting for receipt"],
    ["held", "Held · waiting for your contact"],
    ["delivered", "Received by peer"],
    ["queued", "Not confirmed yet · sends again by itself"],
    ["failed", "Delivery unconfirmed"],
  ] as const)("says a %s message is %s", (delivery, text) => {
    bubble({ sender: "me", delivery });
    expect(screen.getByRole("status")).toHaveTextContent(text);
  });

  it("says nothing about delivery on the contact's messages, or mine without a delivery state", () => {
    const { rerender } = bubble({ delivery: "failed" });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    rerender(<MessageBubble message={message({ sender: "me" })} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("offers a failed message again, with why it failed", async () => {
    const { user, engine } = bubble({ sender: "me", delivery: "failed", deliveryError: "The contact's app is closed" });
    act(() => engine.update({ links: [linkView()] }));
    engine.on("retryMessage", () => undefined);
    expect(screen.getByRole("status")).toHaveTextContent("The contact's app is closed");
    await user.click(screen.getByRole("button", { name: "Retry message" }));
    expect(engine.callsTo("retryMessage")).toEqual([{ linkId: "link-1", messageId: "m1" }]);
  });

  it("asks nothing of the person while a message is being sent again by itself", () => {
    bubble({ sender: "me", delivery: "queued", deliveryError: "Connection closed before receipt." });
    expect(screen.getByRole("status")).not.toHaveTextContent("Delivery unconfirmed");
    expect(screen.queryByRole("button", { name: "Retry message" })).not.toBeInTheDocument();
  });

  it("does not retry into a chat that is not there", async () => {
    const { user, engine } = bubble({ sender: "me", delivery: "failed" });
    await user.click(screen.getByRole("button", { name: "Retry message" }));
    expect(engine.callsTo("retryMessage")).toEqual([]);
  });

  // The check mark: a second tick once the contact has it.
  const ticks = (container: HTMLElement) => container.querySelectorAll('svg[viewBox="0 0 16 11"] path').length;

  it.each([
    ["delivered", { delivery: "delivered" }, 0, 2],
    ["sent, whatever the old acknowledgement says", { delivery: "sent" }, Number.MAX_SAFE_INTEGER, 1],
    ["acknowledged, without a delivery state", {}, 1_700_000_000_000, 2],
    ["not acknowledged yet", {}, 1_699_999_999_999, 1],
  ] as const)("ticks a message of mine %s", (_, patch, peerAck, count) => {
    const { container } = bubble({ sender: "me", ...patch }, { peerAck });
    expect(ticks(container)).toBe(count);
  });

  it("puts no tick on the contact's messages", () => {
    const { container } = bubble({}, { peerAck: Number.MAX_SAFE_INTEGER });
    expect(ticks(container)).toBe(0);
  });
});

describe("MessageBubble: deleting", () => {
  it("deletes only after the menu says it is only here", async () => {
    const onDelete = vi.fn();
    const { user } = bubble({ text: "oops" }, { onDelete });
    await user.click(screen.getByRole("button", { name: "Delete message" }));
    expect(screen.getByTestId("message-delete-menu")).toHaveTextContent("Deleted only here. Your contact keeps their copy.");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByTestId("message-delete-menu")).not.toBeInTheDocument();
    expect(onDelete).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Delete message" }));
    await user.click(screen.getByTestId("message-delete-confirm"));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("message-delete-menu")).not.toBeInTheDocument();
  });

  it("closes the menu on a click elsewhere", async () => {
    const onDelete = vi.fn();
    const { user } = renderApp(<><p>elsewhere</p><MessageBubble message={message({ sender: "me" })} onDelete={onDelete} /></>);
    await user.click(screen.getByRole("button", { name: "Delete message" }));
    await user.click(screen.getByText("elsewhere"));
    expect(screen.queryByTestId("message-delete-menu")).not.toBeInTheDocument();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("offers no delete where the chat cannot be edited", () => {
    bubble({ text: "kept" });
    expect(screen.queryByRole("button", { name: "Delete message" })).not.toBeInTheDocument();
  });
});
