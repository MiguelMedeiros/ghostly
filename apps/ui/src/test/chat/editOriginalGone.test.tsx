import { act, fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MESSAGE_CHANGES_TICK_MS } from "@ghostly/browser/platform/engine";
import type { StoredMessage } from "@ghostly/browser/shared/types";
import { saveSession } from "../../lib/storage";
import { Chat } from "../../pages/Chat";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: chat.edit, chat.paired.delete-message

/*
 * The composer's edit bar follows the message as the chat has it, as the reply bar does: one of mine deleted while I
 * edit it (here from its ⋮, or for everyone from another of my devices) ends the edit, its words with it, and the
 * draft set aside comes back. Enter then sends that draft, not an edit of a message that is gone.
 */

vi.unmock("@ghostly/browser/platform/sync");
vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {}, warmSound: () => {} }));

const PEER = "peer".padEnd(52, "p"), LINK = "link-heron";
const WIRE = "M".repeat(22);
const mine: StoredMessage = { linkId: LINK, id: `me_${WIRE}`, wireId: WIRE, text: "heron note 8812", sender: "me", timestamp: Date.now() - 60_000, delivery: "delivered", via: "datalink" };
const hello: StoredMessage = { linkId: LINK, id: `peer_${"H".repeat(22)}`, text: "hello there", sender: "peer", timestamp: Date.now() - 120_000, via: "datalink" };
const tick = () => act(() => new Promise((resolve) => setTimeout(resolve, MESSAGE_CHANGES_TICK_MS * 2)));

async function openChat() {
  saveSession({ id: "heron", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", messages: [], createdAt: Date.now() - 600_000 });
  const utils = renderApp(<Chat sessionId="heron" visible onCallChange={() => {}} callLayer={null} />, { route: "/chat/heron" });
  utils.engine.on("ensureLink", () => ({ linkId: LINK })).on("setActiveLink", () => undefined).on("sendMessage", () => ({ error: null }))
    .on("editMessage", () => ({ error: "Only your own text messages can be edited", refused: true }))
    .update({ links: [linkView({ id: LINK, peerPubKeyZ32: PEER, profile: "paired-chat/1", pairing: { status: "ready" } } as never)] });
  utils.engine.messages(LINK, [hello, mine]);
  await tick();
  await screen.findByText("heron note 8812");
  return utils;
}

const row = (id: string) => document.querySelector<HTMLElement>(`[data-message-id="${id}"]`)!;
const field = () => screen.getByPlaceholderText<HTMLTextAreaElement>("Message…");

describe("an edit bar on a message of mine that is deleted", () => {
  it("closes with its words, the draft comes back, and Enter sends the draft", async () => {
    const { engine, user } = await openChat();
    fireEvent.change(field(), { target: { value: "my draft" } });
    await user.click(within(row(mine.id)).getByTestId("message-options"));
    await user.click(screen.getByTestId("message-edit"));
    await tick();
    expect(screen.getByTestId("composer-edit")).toHaveTextContent("heron note 8812");
    expect(field()).toHaveValue("heron note 8812");
    fireEvent.change(field(), { target: { value: "heron note 8813" } });

    act(() => engine.emit({ kind: "message-changes", linkId: LINK, messages: [], deleted: [mine.id] }));
    await tick();
    expect(row(mine.id)).toBeNull();
    expect(screen.queryByTestId("composer-edit")).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("heron note 8812");
    expect(field()).toHaveValue("my draft");

    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await tick();
    expect(engine.callsTo("editMessage")).toEqual([]);
    expect(engine.callsTo("sendMessage").filter((c) => c.text === "my draft").length).toBe(1);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("deleted from its own ⋮ while it is edited: the edit ends as Cancel would", async () => {
    const { engine, user } = await openChat();
    engine.on("deleteMessage", ({ messageId }: { messageId: string }) => {
      setTimeout(() => engine.emit({ kind: "message-changes", linkId: LINK, messages: [], deleted: [messageId] }));
      return { everyone: false };
    });
    await user.click(within(row(mine.id)).getByTestId("message-options"));
    await user.click(screen.getByTestId("message-edit"));
    await tick();
    expect(screen.getByTestId("composer-edit")).toBeInTheDocument();

    await user.click(within(row(mine.id)).getByTestId("message-options"));
    await user.click(screen.getByTestId("message-delete"));
    await user.click(screen.getByTestId("message-delete-confirm"));
    await tick();
    expect(engine.callsTo("deleteMessage").length).toBe(1);
    expect(row(mine.id)).toBeNull();
    expect(screen.queryByTestId("composer-edit")).not.toBeInTheDocument();
    expect(field()).toHaveValue("");
  });
});
