import { act, fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MESSAGE_CHANGES_TICK_MS } from "@ghostly/browser/platform/engine";
import type { StoredMessage } from "@ghostly/browser/shared/types";
import { saveSession } from "../../lib/storage";
import { Chat } from "../../pages/Chat";
import { linkView, type FakeEngine } from "../fakeEngine";
import { renderApp } from "../render";

// covers: chat.replies, chat.paired.delete-message, chat.forward

/*
 * The composer's reply bar, and the messages chosen to forward, follow the message as the chat has it now: the
 * contact's edit shows its new text, and a message deleted for everyone leaves them, its words with it. The draft stays.
 */

vi.unmock("@ghostly/browser/platform/sync");
vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {}, warmSound: () => {} }));

const PEER = "peer".padEnd(52, "p"), LINK = "link-zebra", WIRE = "Z".repeat(22);
const zebra: StoredMessage = { linkId: LINK, id: `peer_${WIRE}`, text: "zebra secret 4472", sender: "peer", timestamp: Date.now() - 60_000, via: "datalink" };
const hello: StoredMessage = { linkId: LINK, id: `peer_${"H".repeat(22)}`, text: "hello there", sender: "peer", timestamp: Date.now() - 120_000, via: "datalink" };
const tick = () => act(() => new Promise((resolve) => setTimeout(resolve, MESSAGE_CHANGES_TICK_MS * 2)));

async function openChat(last = zebra) {
  saveSession({ id: "zebra", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", messages: [], createdAt: Date.now() - 600_000 });
  const utils = renderApp(<Chat sessionId="zebra" visible onCallChange={() => {}} callLayer={null} />, { route: "/chat/zebra" });
  utils.engine.on("ensureLink", () => ({ linkId: LINK })).on("setActiveLink", () => undefined).on("sendMessage", () => ({ error: null }))
    .update({ links: [linkView({ id: LINK, peerPubKeyZ32: PEER, profile: "paired-chat/1", pairing: { status: "ready" } } as never)] });
  utils.engine.messages(LINK, [hello, last]);
  await tick();
  await screen.findByText(last.text);
  return utils;
}

const row = (id: string) => document.querySelector<HTMLElement>(`[data-message-id="${id}"]`)!;
const field = () => screen.getByPlaceholderText<HTMLTextAreaElement>("Message…");
/** The texts the composer sent, with the reply each carried (the chat's own joined line left out). */
const drafts = (engine: FakeEngine) => engine.callsTo("sendMessage").filter((c) => c.text === "my draft answer").map((c) => [c.text, c.replyTo]);

async function replyToZebra() {
  fireEvent.click(within(row(zebra.id)).getByTestId("message-reply-action"));
  await tick();
  expect(within(screen.getByTestId("composer-reply")).getByTestId("reply-quote-snippet")).toHaveTextContent("zebra secret 4472");
  fireEvent.change(field(), { target: { value: "my draft answer" } });
}

describe("a reply bar on a message the contact changes", () => {
  it("closes when it is deleted for everyone: its words go, the draft stays, and Send goes as a plain message", async () => {
    const { engine } = await openChat();
    await replyToZebra();
    act(() => engine.emit({ kind: "message-changes", linkId: LINK, messages: [], deleted: [zebra.id] }));
    await tick();
    expect(row(zebra.id)).toBeNull();
    expect(screen.queryByTestId("composer-reply")).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("zebra secret");
    expect(field()).toHaveValue("my draft answer");

    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await tick();
    expect(drafts(engine)).toEqual([["my draft answer", undefined]]);
  });

  it("shows the contact's edit, and the reply that goes is to that message", async () => {
    const { engine } = await openChat();
    await replyToZebra();
    act(() => engine.emit({ kind: "message-changes", linkId: LINK, messages: [{ ...zebra, text: "zebra secret 4473", edit: { seq: 1, at: Date.now(), history: [{ at: zebra.timestamp, text: zebra.text }] } }], deleted: [] }));
    await tick();
    expect(row(zebra.id)).toHaveTextContent("zebra secret 4473");
    expect(within(screen.getByTestId("composer-reply")).getByTestId("reply-quote-snippet")).toHaveTextContent("zebra secret 4473");
    expect(document.body).not.toHaveTextContent("zebra secret 4472");

    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await tick();
    expect(drafts(engine)).toEqual([["my draft answer", zebra.id]]);
    expect(screen.queryByTestId("composer-reply")).not.toBeInTheDocument();
  });
});

describe("messages chosen to forward", () => {
  it("one deleted for everyone is no longer chosen; the last one gone ends the choice", async () => {
    const { engine, user } = await openChat();
    await user.click(within(row(zebra.id)).getByTestId("message-options"));
    await user.click(screen.getByTestId("message-select-start"));
    fireEvent.click(screen.getByText("hello there"));
    expect(screen.getByTestId("select-count")).toHaveTextContent("2 selected");

    act(() => engine.emit({ kind: "message-changes", linkId: LINK, messages: [], deleted: [zebra.id] }));
    await tick();
    expect(screen.getByTestId("select-count")).toHaveTextContent("1 selected");
    act(() => engine.emit({ kind: "message-changes", linkId: LINK, messages: [], deleted: [hello.id] }));
    await tick();
    expect(screen.queryByTestId("select-bar")).not.toBeInTheDocument();
  });

  /** Both chosen, Forward pressed: "Forward to…" open on them (the one chat to send to is this one). */
  async function forwardBoth(first: StoredMessage) {
    const utils = await openChat(first);
    utils.engine.on("forwardMessages", ({ to, messageIds }: { to: string[]; messageIds: string[] }) => ({ results: to.map(t => ({ to: t, messageIds, error: null })) }));
    await tick();
    await utils.user.click(within(row(first.id)).getByTestId("message-options"));
    await utils.user.click(screen.getByTestId("message-select-start"));
    fireEvent.click(screen.getByText("hello there"));
    await utils.user.click(screen.getByTestId("select-forward"));
    expect(screen.getByTestId("forward-count")).toHaveTextContent("2 messages");
    return utils;
  }

  it("one deleted for everyone while Forward to… is open leaves it; Send forwards the rest", async () => {
    const { engine, user } = await forwardBoth(zebra);
    act(() => engine.emit({ kind: "message-changes", linkId: LINK, messages: [], deleted: [zebra.id] }));
    await tick();
    expect(screen.getByTestId("forward-dialog")).toBeInTheDocument();
    expect(screen.queryByTestId("forward-count")).not.toBeInTheDocument();

    await user.click(screen.getAllByTestId("forward-target")[0]!);
    await user.click(screen.getByTestId("forward-send"));
    expect(engine.callsTo("forwardMessages")).toEqual([{ linkId: LINK, messageIds: [hello.id], to: [LINK] }]);
    expect(screen.queryByTestId("forward-error")).not.toBeInTheDocument();
  });

  it("a deleted seed no longer asks before the rest goes", async () => {
    const seed: StoredMessage = { ...zebra, text: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about" };
    const { engine, user } = await forwardBoth(seed);
    act(() => engine.emit({ kind: "message-changes", linkId: LINK, messages: [], deleted: [seed.id] }));
    await tick();

    await user.click(screen.getAllByTestId("forward-target")[0]!);
    await user.click(screen.getByTestId("forward-send"));
    expect(screen.queryByTestId("secret-guard")).not.toBeInTheDocument();
    expect(engine.callsTo("forwardMessages")).toEqual([{ linkId: LINK, messageIds: [hello.id], to: [LINK] }]);
  });

  it("the last one deleted closes Forward to…", async () => {
    const { engine } = await forwardBoth(zebra);
    act(() => engine.emit({ kind: "message-changes", linkId: LINK, messages: [], deleted: [zebra.id, hello.id] }));
    await tick();
    expect(screen.queryByTestId("forward-dialog")).not.toBeInTheDocument();
    expect(screen.queryByTestId("select-bar")).not.toBeInTheDocument();
    expect(engine.callsTo("forwardMessages")).toEqual([]);
  });
});
