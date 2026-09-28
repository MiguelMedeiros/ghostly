import { act, fireEvent, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { Route, Routes, useLocation } from "react-router-dom";
import { MessageBubble } from "../../components/MessageBubble";
import { ForwardDialog } from "../../components/chat/ForwardDialog";
import { useForwarding } from "../../hooks/useForwarding";
import { canForward, forwardSecret } from "../../lib/forward";
import { saveSession } from "../../lib/storage";
import type { ChatMessage, ChatSession } from "../../lib/types";
import { engineState, fakeEngine, groupView, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: chat.forward

/** An old message (no entry animation) from the contact, unless the patch says otherwise. */
const message = (patch: Partial<ChatMessage> = {}): ChatMessage => ({ id: "m1", text: "hello", sender: "peer", timestamp: 1_700_000_000_000, ...patch });
const PICTURE = { id: "link-1-in-p", name: "ghost.png", size: 12, mime: "image/png" };
const SEED = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

function chat(id: string, peer: string, nick: string, last: number) {
  saveSession({ id, mySeedB64: "s", peerPubKeyB64: peer, encKeyB64: "e", nick, createdAt: 1, messages: [{ id: "x", text: "hi", sender: "peer", timestamp: last }] } as unknown as ChatSession);
}

beforeEach(() => {
  chat("chat-ana", "peer-ana", "Ana", 3_000);
  chat("chat-bo", "peer-bo", "Bo", 1_000);
  fakeEngine.setState(engineState({
    links: [linkView({ id: "link-ana", peerPubKeyZ32: "peer-ana" }), linkView({ id: "link-bo", peerPubKeyZ32: "peer-bo" })],
    groups: [groupView({ id: "g1", name: "Friends", lastMessageAt: 2_000 }), groupView({ id: "g2", name: "Readers", canSend: false })],
  }));
});

describe("which messages have Forward", () => {
  it("texts and files, not payments, call lines or notices", () => {
    expect(canForward(message())).toBe(true);
    expect(canForward(message({ text: "", file: PICTURE }))).toBe(true);
    expect(canForward(message({ paymentId: "pay-1" }))).toBe(false);
    expect(canForward(message({ sender: "system", callEvent: { type: "call_missed" } }))).toBe(false);
    expect(canForward(message({ sender: "system", systemEvent: { type: "join" } }))).toBe(false);
  });

  it("the ⋮ says Forward and Select for a text; a message without them has neither", async () => {
    const { user } = renderApp(<><MessageBubble message={message()} peerPubKey="peer" onForward={() => {}} onSelect={() => {}} />
      <MessageBubble message={message({ id: "m2", paymentId: "pay-1" })} peerPubKey="peer" /></>);
    const [text, payment] = screen.getAllByTestId("message-options");
    await user.click(text!);
    expect(screen.getByTestId("message-forward")).toHaveTextContent("Forward");
    expect(screen.getByTestId("message-select-start")).toHaveTextContent("Select");
    await user.keyboard("{Escape}");
    await user.click(payment!);
    expect(screen.queryByTestId("message-forward")).toBeNull();
    expect(screen.queryByTestId("message-select-start")).toBeNull();
  });

  it("a file still arriving has Forward greyed, with the reason", async () => {
    fakeEngine.update({ transfers: { [PICTURE.id]: { state: "transferring", transferred: 4, size: 12 } } });
    const { user } = renderApp(<MessageBubble message={message({ text: "", file: PICTURE })} peerPubKey="peer" onForward={() => {}} />);
    await user.click(screen.getByTestId("message-options"));
    expect(screen.getByTestId("message-forward")).toBeDisabled();
    expect(screen.getByTestId("message-forward")).toHaveTextContent("Not received yet");
  });
});

describe("the Forwarded label", () => {
  it("says Forwarded, and Forwarded many times from five hops, never from whom", () => {
    renderApp(<><MessageBubble message={message({ forwarded: 1 })} peerPubKey="peer" />
      <MessageBubble message={message({ id: "m2", forwarded: 5 })} peerPubKey="peer" />
      <MessageBubble message={message({ id: "m3" })} peerPubKey="peer" /></>);
    const labels = screen.getAllByTestId("message-forwarded");
    expect(labels.map(l => l.textContent)).toEqual(["Forwarded", "Forwarded many times"]);
    expect(labels[1]).toHaveAttribute("data-many", "true");
  });
});

describe("the Forward to… picker", () => {
  function Where() {
    return <p data-testid="where">{useLocation().pathname}</p>;
  }
  const open = (messages: ChatMessage[], from = "link-bo") => renderApp(<Routes>
    <Route path="/here" element={<ForwardDialog from={from} messages={messages} onClose={() => {}} />} />
    <Route path="*" element={<Where />} />
  </Routes>, { route: "/here" });
  const names = () => screen.getAllByTestId("forward-target").map(row => row.querySelector("bdi")?.textContent);

  it("lists chats and the groups this device can write in, most recent first, and finds them by name", async () => {
    const { user } = open([message()]);
    expect(names()).toEqual(["Ana", "Friends", "Bo"]);
    await user.type(screen.getByTestId("forward-search"), "fri");
    expect(names()).toEqual(["Friends"]);
    await user.type(screen.getByTestId("forward-search"), "x");
    expect(screen.getByTestId("forward-none")).toHaveTextContent("No chat by that name");
  });

  it("offers no group for a file: groups take text only", () => {
    open([message({ text: "", file: PICTURE })]);
    expect(names()).toEqual(["Ana", "Bo"]);
    expect(screen.getByTestId("forward-files-hint")).toHaveTextContent("Groups take text only");
  });

  it("sends to the chosen ones and, for one, opens it", async () => {
    fakeEngine.on("forwardMessages", ({ to }: { to: string[] }) => ({ results: to.map(t => ({ to: t, messageIds: ["me_1"], error: null })) }));
    const { user } = open([message()]);
    expect(screen.getByTestId("forward-send")).toBeDisabled();
    await user.click(screen.getAllByTestId("forward-target")[0]!);
    expect(screen.getAllByTestId("forward-target")[0]).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("forward-chosen")).toHaveTextContent("Ana");
    await user.click(screen.getByTestId("forward-send"));
    expect(fakeEngine.callsTo("forwardMessages")).toEqual([{ linkId: "link-bo", messageIds: ["m1"], to: ["link-ana"] }]);
    expect(screen.getByTestId("where")).toHaveTextContent("/chat/chat-ana");
  });

  it("takes at most five, and says what a chat refused", async () => {
    for (const n of [1, 2, 3, 4]) chat(`chat-${n}`, `peer-${n}`, `P${n}`, 500 - n);
    fakeEngine.update({ links: ["ana", "bo", "1", "2", "3", "4"].map(n => linkView({ id: `link-${n}`, peerPubKeyZ32: `peer-${n}` })) });
    fakeEngine.on("forwardMessages", ({ to }: { to: string[] }) => ({ results: to.map(t => ({ to: t, messageIds: [], error: t === "group:g1" ? "You are not in this group" : null })) }));
    const { user } = open([message()]);
    const rows = screen.getAllByTestId("forward-target");
    for (const row of rows.slice(0, 5)) await user.click(row);
    expect(rows[5]).toBeDisabled();
    await user.click(screen.getByTestId("forward-send"));
    expect(fakeEngine.callsTo("forwardMessages")[0]).toMatchObject({ to: ["link-ana", "group:g1", "link-bo", "link-1", "link-2"] });
    expect(screen.getByTestId("forward-error")).toHaveTextContent("Friends: You are not in this group");
    expect(screen.queryByTestId("where")).toBeNull();
  });

  it("asks before forwarding text that looks like a seed, as typing it would", async () => {
    expect(forwardSecret([message({ text: SEED })])).toMatchObject({ kind: "mnemonic" });
    fakeEngine.on("forwardMessages", ({ to }: { to: string[] }) => ({ results: to.map(t => ({ to: t, messageIds: [], error: null })) }));
    const { user } = open([message({ text: SEED })]);
    await user.click(screen.getAllByTestId("forward-target")[0]!);
    await user.click(screen.getByTestId("forward-send"));
    expect(screen.getByTestId("secret-guard")).toHaveAttribute("data-kind", "mnemonic");
    await user.click(screen.getByTestId("secret-guard-cancel"));
    expect(fakeEngine.callsTo("forwardMessages")).toEqual([]);
    await user.click(screen.getByTestId("forward-send"));
    await user.click(screen.getByTestId("secret-guard-send"));
    expect(fakeEngine.callsTo("forwardMessages")).toHaveLength(1);
  });
});

describe("choosing several", () => {
  function Timeline({ messages }: { messages: ChatMessage[] }) {
    const forwarding = useForwarding("link-bo", messages);
    return <>
      {messages.map(m => <MessageBubble key={m.id} message={m} peerPubKey="peer" onDelete={() => {}} {...forwarding.rowProps(m)} />)}
      {forwarding.bar}
      {forwarding.dialog}
    </>;
  }
  const messages = [message({ id: "a", text: "first", timestamp: 1 }), message({ id: "p", paymentId: "pay-1", timestamp: 2 }), message({ id: "b", text: "second", timestamp: 3 })];

  it("Select starts it; rows become checkboxes, a payment cannot be chosen, Forward takes them in order", async () => {
    const { user } = renderApp(<Timeline messages={messages} />);
    await user.click(screen.getAllByTestId("message-options")[2]!);
    await user.click(screen.getByTestId("message-select-start"));
    expect(screen.getByTestId("select-count")).toHaveTextContent("1 selected");
    // The rows' menus wait while messages are chosen.
    expect(screen.queryAllByTestId("message-options")).toHaveLength(0);
    const boxes = screen.getAllByTestId("message-select");
    expect(boxes.map(b => b.getAttribute("aria-checked"))).toEqual(["false", "false", "true"]);
    expect(boxes[1]).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(boxes[1]!);
    fireEvent.click(screen.getByText("first"));
    expect(screen.getByTestId("select-count")).toHaveTextContent("2 selected");
    await user.click(screen.getByTestId("select-forward"));
    const dialog = screen.getByTestId("forward-dialog");
    expect(within(dialog).getByTestId("forward-count")).toHaveTextContent("2 messages");
    fakeEngine.on("forwardMessages", ({ to }: { to: string[] }) => ({ results: to.map(t => ({ to: t, messageIds: [], error: null })) }));
    await user.click(within(dialog).getAllByTestId("forward-target")[0]!);
    await user.click(within(dialog).getAllByTestId("forward-target")[1]!);
    await user.click(within(dialog).getByTestId("forward-send"));
    expect(fakeEngine.callsTo("forwardMessages")).toEqual([{ linkId: "link-bo", messageIds: ["a", "b"], to: ["link-ana", "group:g1"] }]);
    // Sent: the choice is over.
    expect(screen.queryByTestId("select-bar")).toBeNull();
  });

  it("Escape, ✕ or taking the last one off ends it", async () => {
    const { user } = renderApp(<Timeline messages={messages} />);
    await user.click(screen.getAllByTestId("message-options")[0]!);
    await user.click(screen.getByTestId("message-select-start"));
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    expect(screen.queryByTestId("select-bar")).toBeNull();
    await user.click(screen.getAllByTestId("message-options")[0]!);
    await user.click(screen.getByTestId("message-select-start"));
    await user.click(screen.getByTestId("select-cancel"));
    expect(screen.queryByTestId("select-bar")).toBeNull();
    await user.click(screen.getAllByTestId("message-options")[0]!);
    await user.click(screen.getByTestId("message-select-start"));
    fireEvent.click(screen.getByText("first"));
    expect(screen.queryByTestId("select-bar")).toBeNull();
  });
});
