import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Chat } from "../../pages/Chat";
import { saveSession, setStorageProfile } from "../../lib/storage";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {}, warmSound: () => {}, playCue: vi.fn() }));

const PEER = "peer".padEnd(52, "p");
/** The engine's DHT_PACKET_BUDGET (core dhtDelivery.ts): a text or an edit within 256 bytes the sealed packet cannot carry. */
const BUDGET = "Text and authentication exceed the DHT packet budget. Shorten the message.";

const LIVE_LATER = "Too long for the DHT, which carries about 248 bytes. Shorten it, or send it once you're connected peer to peer.";
const MINE = "Too long for the DHT, which carries about 248 bytes. This chat is on DHT only: shorten it, or change it from the connection icon.";
const THEIRS = "Too long for the DHT, which carries about 248 bytes. Your contact's chat is on DHT only: shorten it, or wait until they allow live again.";
const BOTH = "Too long for the DHT, which carries about 248 bytes. You and your contact keep this chat on DHT only: shorten it, or both change it from the connection icon.";
const WAITS = "Over the 248 bytes the DHT carries: it is sent when you are live";

/**
 * A 1:1 chat off the live link, on the DHT floor. The engine refuses a text of about 249-256 bytes there (sealed, it
 * does not fit the packet) and an edit past about 214: the composer counted against 256, muted and with no title, and
 * only the refusal after Send said it, with a next step a DHT-only chat never reaches by itself.
 */
function openChat(link: Record<string, unknown>, messages: never[] = []) {
  saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", messages, createdAt: 1_700_000_000_000 });
  const app = renderApp(<Chat sessionId="chat-1" visible onCallChange={() => {}} callLayer={null} />);
  app.engine.on("sendMessage", async () => ({ error: BUDGET, refused: true }))
    .on("editMessage", async () => ({ error: BUDGET, refused: true }))
    .update({ settings: { online: true }, links: [linkView({ peerPubKeyZ32: PEER, profile: "paired-chat/1", dataLink: "idle", textDelivery: "dht",
      ...link, dhtDelivery: { mode: "stream", authenticated: true, maxTextBytes: 256, ...(link.dhtDelivery as object) } } as never)] } as never);
  return app;
}

async function type(text: string) {
  const field = await screen.findByPlaceholderText("Message…");
  fireEvent.change(field, { target: { value: text } });
  return field;
}

afterEach(() => { localStorage.clear(); setStorageProfile(""); });

// covers: chat.dht.send
describe("the DHT byte count off the live link", () => {
  it("counts a text against the about 248 bytes the packet carries, quiet up to them", async () => {
    openChat({});
    await type("x".repeat(248));
    const counter = await screen.findByTestId("dht-byte-count");
    expect(counter).toHaveTextContent("248 / 248 B");
    expect(counter).not.toHaveAttribute("title");
    expect(counter.className).toContain("text-text-muted");
  });

  it.each([
    ["a chat that goes live", {}, LIVE_LATER],
    ["a chat on DHT only by this side", { deliveryMode: "dht" }, MINE],
    ["a chat on DHT only by the contact", { dhtDelivery: { peerMode: "dht" } }, THEIRS],
    ["a chat on DHT only by both sides", { deliveryMode: "dht", dhtDelivery: { peerMode: "dht" } }, BOTH],
  ])("past them in %s, warns before Send with what the refusal says after it", async (_, link, said) => {
    const { user } = openChat(link);
    const field = await type("x".repeat(250));
    const counter = await screen.findByTestId("dht-byte-count");
    expect(counter).toHaveTextContent("250 / 248 B");
    expect(counter.className).toContain("text-warn-ink");
    expect(counter).toHaveAttribute("title", said);
    await user.click(field);
    await user.keyboard("{Enter}");
    expect(await screen.findByText(said)).toBeInTheDocument();
  });

  it("past 256 bytes, in a chat that goes live, says it is sent when live", async () => {
    openChat({});
    await type("x".repeat(300));
    expect(await screen.findByTestId("dht-byte-count")).toHaveAttribute("title", WAITS);
  });

  // The packet carries the text JSON-escaped: a new line, a quote or a backslash takes two bytes there.
  it.each([
    ["new lines", `${"x".repeat(60)}\n`.repeat(4) + "x".repeat(1), 249],
    ["quotes", 'xxxxxxxxx"'.repeat(23), 253],
    ["backslashes", "x".repeat(240) + "\\".repeat(9), 258],
  ])("counts a text with %s as the packet does", async (_, text, escaped) => {
    openChat({});
    await type(text);
    const counter = await screen.findByTestId("dht-byte-count");
    expect(counter).toHaveTextContent(`${escaped} / 248 B`);
    expect(counter.className).toContain("text-warn-ink");
    expect(counter).toHaveAttribute("title", LIVE_LATER);
  });

  it("with no DHT to carry it, says a text that long waits for live, not to shorten it", async () => {
    openChat({ textDelivery: "unavailable" });
    await type("x".repeat(250));
    expect(await screen.findByTestId("dht-byte-count")).toHaveAttribute("title", WAITS);
  });

  it("where both sides allow held messages, says it is held", async () => {
    openChat({ textDelivery: "hold" });
    await type("x".repeat(250));
    expect(await screen.findByTestId("dht-byte-count")).toHaveAttribute("title", "Longer than the DHT carries (about 248 bytes): it is kept for your contact until they are online.");
  });

  it.each([
    ["a chat that goes live", {}, "Too long for the DHT as an edit, which carries about 214 bytes: it goes when you are live."],
    ["a chat on DHT only by this side", { deliveryMode: "dht" }, "Too long for the DHT, which carries about 214 bytes. This chat is on DHT only: shorten it, or change it from the connection icon."],
  ])("an edit counts against the about 214 bytes it fits, in %s", async (_, link, said) => {
    const { user } = openChat(link, [{ id: "me_w1", ref: "w1", text: "first", sender: "me", timestamp: 1_700_000_000_500, delivery: "delivered" } as never]);
    const field = await screen.findByPlaceholderText("Message…");
    await screen.findByText("first");
    await user.click(field);
    await user.keyboard("{ArrowUp}");
    await waitFor(() => expect(field).toHaveValue("first"));
    fireEvent.change(field, { target: { value: "x".repeat(220) } });
    const counter = await screen.findByTestId("dht-byte-count");
    expect(counter).toHaveTextContent("220 / 214 B");
    expect(counter).toHaveAttribute("title", said);
  });

  it("an edit the engine refuses in a DHT-only chat names the connection icon", async () => {
    const { user } = openChat({ deliveryMode: "dht" }, [{ id: "me_w1", ref: "w1", text: "first", sender: "me", timestamp: 1_700_000_000_500, delivery: "delivered" } as never]);
    const field = await screen.findByPlaceholderText("Message…");
    await screen.findByText("first");
    await user.click(field);
    await user.keyboard("{ArrowUp}");
    await waitFor(() => expect(field).toHaveValue("first"));
    fireEvent.change(field, { target: { value: "x".repeat(220) } });
    await user.keyboard("{Enter}");
    expect(await screen.findByText("Too long for the DHT, which carries about 214 bytes. This chat is on DHT only: shorten it, or change it from the connection icon.")).toBeInTheDocument();
  });
});
