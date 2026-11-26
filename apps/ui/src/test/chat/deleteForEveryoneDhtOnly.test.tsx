import { act, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { readStatusCard, statusCardText } from "@ghostly/core";
import { RESEND_POLICY } from "@ghostly/browser/engine/outbox";
import { MessageBubble } from "../../components/MessageBubble";
import type { ChatMessage } from "../../lib/types";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: chat.paired.delete-message, chat.dht.send

/**
 * Delete for everyone in a 1:1 chat on DHT only. A removal never goes on the DHT floor nor as a held item: it waits for
 * the live session (WISP 400 § Delete for everyone, Delivery), which a chat on DHT only does not open until the side
 * that chose it leaves it, and is given up a week after the delete. The confirmation said "Deleted from your contact's
 * devices too", and the contact kept the message for as long as the chat stayed there, with nothing on this side saying so.
 */
const message = (patch: Partial<ChatMessage> = {}): ChatMessage => ({ id: "me_1", ref: "w1", text: "wrong chat", sender: "me", timestamp: 1_700_000_000_000, delivery: "delivered", ...patch });
const theirs = { mode: "stream", peerMode: "dht", authenticated: true, maxTextBytes: 256 } as const;
const MINE = /^Deleted here now\. Your contact's devices delete it only if the chat is live again within a week: this chat is on DHT only, change it from the connection icon\./;
const THEIRS = /^Deleted here now\. Your contact's devices delete it only if the chat is live again within a week: your contact's chat is on DHT only, until they allow live again\./;

async function confirmation(link: Parameters<typeof linkView>[0] | null, props: { linkId?: string; language?: "en" | "pt"; patch?: Partial<ChatMessage> } = {}) {
  const utils = renderApp(<MessageBubble message={message(props.patch)} peerPubKey="peer" linkId={props.linkId} onDelete={vi.fn()} onDeleteForEveryone={vi.fn()} />, { language: props.language });
  if (link) act(() => utils.engine.update({ links: [linkView(link)] }));
  await utils.user.click(screen.getByTestId("message-options"));
  await utils.user.click(screen.getByTestId("message-delete-everyone"));
  return { menu: screen.getByTestId("message-delete-menu"), ...utils };
}

describe("Delete for everyone in a chat on DHT only", () => {
  it.each([
    ["I chose DHT only", { deliveryMode: "dht" }, MINE],
    ["the contact chose DHT only", { textDelivery: "dht", dhtDelivery: theirs }, THEIRS],
    // The contact's choice keeps the chat off a live session while its texts are held for the contact too (the header
    // names the hold then): a removal is never held.
    ["the contact chose DHT only and texts are held", { textDelivery: "hold", dhtDelivery: theirs }, THEIRS],
    // Both chose it: mine is said, the one that can be changed here.
    ["both chose DHT only", { deliveryMode: "dht", dhtDelivery: { ...theirs, mode: "dht" } }, MINE],
  ] as const)("says the contact's copy goes only if the chat is live again within a week, when %s", async (_, link, hint) => {
    const { menu } = await confirmation({ ...link });
    expect(menu.querySelector("p")).toHaveTextContent(hint);
    expect(menu.querySelector("p")).toHaveTextContent(/Older apps show "Message removed"; saved copies stay\.$/);
    // What a screen reader says with the focus on Cancel and on Delete.
    expect(menu).toHaveAccessibleDescription(hint);
    expect(screen.getByTestId("message-delete-confirm")).toHaveAccessibleDescription(hint);
  });

  it("says a week because a removal not confirmed is given up a week after the delete", () => {
    expect(RESEND_POLICY.windowMs).toBe(7 * 24 * 60 * 60_000);
  });

  it("follows the chat while the confirmation is open", async () => {
    const { menu, engine } = await confirmation({ deliveryMode: "dht" });
    expect(menu.querySelector("p")).toHaveTextContent(MINE);
    act(() => engine.update({ links: [linkView({ deliveryMode: "stream" })] }));
    expect(menu.querySelector("p")).toHaveTextContent(/^Deleted from your contact's devices too\./);
  });

  it("says it of a bot's status card too, whose message is drawn as a card", async () => {
    const card = readStatusCard({ kind: "task", id: "relay", title: "Fix relay rotation", status: "running" })!;
    const { menu } = await confirmation({ deliveryMode: "dht" }, { patch: { text: statusCardText(card), card } });
    expect(screen.getByText("Fix relay rotation")).toBeInTheDocument();
    expect(menu.querySelector("p")).toHaveTextContent(MINE);
  });

  it("keeps its words in a chat that goes live", async () => {
    const { menu } = await confirmation({ deliveryMode: "stream" });
    expect(menu.querySelector("p")).toHaveTextContent(/^Deleted from your contact's devices too\./);
  });

  it("keeps a group's words: a group's removal goes over its members' edges", async () => {
    const { menu } = await confirmation({ deliveryMode: "dht" }, { linkId: "group:g1" });
    expect(menu.querySelector("p")).toHaveTextContent(/^Deleted from the members' devices too\./);
  });

  it("says it in the chat's language", async () => {
    const { menu } = await confirmation({ deliveryMode: "dht" }, { language: "pt" });
    expect(menu.querySelector("p")?.textContent).toMatch(/^Apagada aqui agora\. .* em até uma semana: esta conversa está em Só DHT/);
  });
});
