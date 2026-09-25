import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageDetailsView } from "@ghostly/browser/shared/types";
import { LONG_PRESS_MS, MessageBubble } from "../../components/MessageBubble";
import { buildDetails, formatBytes, formatDuration, pathWords } from "../../lib/messageDetails";
import type { ChatMessage } from "../../lib/types";
import { servicesPlatform } from "../../lib/platform";
import { fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: chat.paired.message-details

/**
 * A message's details (WISP 400 § Message details): opened by a double click, a long press or the ⋮ menu, closed by
 * Escape or a tap outside. Every section says only what the engine recorded; ids and hashes copy on a click; the
 * whole view copies as JSON; and no key is ever in it.
 */

const message = (patch: Partial<ChatMessage> = {}): ChatMessage => ({ id: "me_abc", text: "hello", sender: "me", timestamp: 1_700_000_000_000, delivery: "delivered", ...patch });

const PEER_KEY = "peerkeyz32peerkeyz32peerkeyz32peerkeyz32peerkeyz32pe";
const MY_KEY = "mykeyz32mykeyz32mykeyz32mykeyz32mykeyz32mykeyz32myke";

/** What the engine answers for a text sent live over WebRTC, confirmed 42 ms later. */
const textView = (patch: Partial<MessageDetailsView> = {}): MessageDetailsView => ({
  message: { id: "me_abc", wireId: "wireidwireidwireidwire", linkId: "link-1", sender: "me", timestamp: 1_700_000_000_000, via: "datalink", delivery: "delivered", kind: "text", textBytes: 5 },
  details: {
    sends: [{ at: 1_700_000_000_100, path: "webrtc/1", relayed: false, rttMs: 12, result: "sent" }], attempts: 1,
    sentAt: 1_700_000_000_100, receiptAt: 1_700_000_000_142,
    wire: { frame: "paired-message", protocol: "chat/1", plaintextBytes: 5, wireBytes: 61 },
  },
  link: { id: "link-1", profile: "paired-chat/1", myKey: MY_KEY, peerKey: PEER_KEY, verified: true, transportNow: "webrtc/1", relayedNow: false, rttNowMs: 12 },
  ...patch,
});

function bubble(patch: Partial<ChatMessage> = {}, props: Partial<Parameters<typeof MessageBubble>[0]> = {}) {
  return renderApp(<MessageBubble message={message(patch)} peerPubKey="peer" onDelete={() => {}} {...props} />);
}

const section = (id: string) => screen.getByTestId("message-details").querySelector<HTMLElement>(`[data-section="${id}"]`);
const rows = (id: string) => Object.fromEntries([...section(id)!.querySelectorAll<HTMLElement>("[data-testid=message-details-row]")].map(r => [r.dataset.label, r.dataset.value]));

beforeEach(() => {
  fakeEngine.setState({ links: [linkView({ id: "link-1", peerPubKeyZ32: "peer" })] });
  // A file bubble asks the platform for its bytes; there is no IndexedDB here.
  vi.spyOn(servicesPlatform!, "getFile").mockResolvedValue(null);
});
afterEach(() => vi.useRealTimers());

describe("opening and closing", () => {
  it("a double click opens the details, a click outside closes them, and the focus comes back", async () => {
    fakeEngine.on("messageDetails", () => textView());
    const { user, container } = bubble();
    await user.dblClick(screen.getByText("hello"));
    const panel = await screen.findByTestId("message-details");
    expect(panel).toHaveAttribute("role", "dialog");
    expect(fakeEngine.callsTo("messageDetails")).toEqual([{ linkId: "link-1", messageId: "me_abc" }]);
    await waitFor(() => expect(panel).toHaveAttribute("data-loaded", "yes"));
    expect(container.querySelector("[data-message-row]")).toHaveAttribute("data-details-open", "true");
    await user.click(screen.getByTestId("message-details-backdrop"));
    expect(screen.queryByTestId("message-details")).not.toBeInTheDocument();
    expect(container.querySelector("[data-message-row]")).not.toHaveAttribute("data-details-open");
  });

  it("the ⋮ menu has Details beside Delete, and Details opens them", async () => {
    fakeEngine.on("messageDetails", () => textView());
    const { user } = bubble();
    await user.click(screen.getByTestId("message-options"));
    const menu = screen.getByTestId("message-menu");
    expect(within(menu).getAllByRole("button").map(b => b.textContent)).toEqual(["Details", "Delete message"]);
    await user.click(screen.getByTestId("message-details"));
    expect(await screen.findByRole("dialog", { name: "Message details" })).toBeInTheDocument();
    expect(screen.queryByTestId("message-menu")).not.toBeInTheDocument();
  });

  it("a long press with a finger opens them; a short tap or a moving finger does not", async () => {
    vi.useFakeTimers();
    fakeEngine.on("messageDetails", () => textView());
    const { container } = bubble();
    const row = container.querySelector("[data-message-row]")!;
    const touch = { pointerType: "touch", button: 0, clientX: 10, clientY: 10 };
    fireEvent.pointerDown(row, touch);
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS - 50); });
    fireEvent.pointerUp(row, touch);
    act(() => { vi.advanceTimersByTime(100); });
    expect(screen.queryByTestId("message-details")).not.toBeInTheDocument();

    fireEvent.pointerDown(row, touch);
    fireEvent.pointerMove(row, { ...touch, clientX: 40 });
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS + 10); });
    expect(screen.queryByTestId("message-details")).not.toBeInTheDocument();

    fireEvent.pointerDown(row, touch);
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS + 10); });
    expect(screen.getByTestId("message-details")).toBeInTheDocument();
    // The browser's own long-press menu stays away.
    const contextMenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    fireEvent(row, contextMenu);
    expect(contextMenu.defaultPrevented).toBe(true);
  });

  it("a mouse press is never a long press", () => {
    vi.useFakeTimers();
    const { container } = bubble();
    fireEvent.pointerDown(container.querySelector("[data-message-row]")!, { pointerType: "mouse", button: 0 });
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS * 2); });
    expect(screen.queryByTestId("message-details")).not.toBeInTheDocument();
  });

  it("without an engine answer the panel still shows what the chat knows", async () => {
    fakeEngine.on("messageDetails", () => { throw new Error("gone"); });
    const { user } = bubble({ delivery: "sent" });
    await user.dblClick(screen.getByText("hello"));
    await waitFor(() => expect(screen.getByTestId("message-details")).toHaveAttribute("data-loaded", "yes"));
    expect(rows("identity")).toMatchObject({ "Message id": "me_abc", Kind: "Text", Direction: "Sent by you" });
    expect(rows("delivery")).toMatchObject({ State: "Sent, waiting for the receipt" });
    expect(section("path")).toBeNull();
  });
});

describe("what it says", () => {
  it("a text sent live: the plain-words line, and the identity, path, timing, wire, crypto and delivery sections", async () => {
    fakeEngine.on("messageDetails", () => textView());
    const { user } = bubble();
    await user.dblClick(screen.getByText("hello"));
    await waitFor(() => expect(screen.getByTestId("message-details")).toHaveAttribute("data-loaded", "yes"));
    expect(screen.getByTestId("message-details-summary")).toHaveTextContent("Message sent live over WebRTC, direct, encrypted end to end, receipt in 42 ms.");
    expect(rows("identity")).toMatchObject({ "Message id": "me_abc", Kind: "Text", "Sender key": MY_KEY, "Wire id": "wireidwireidwireidwire", "Chat id": "link-1", "Chat profile": "paired-chat/1", "Text size": "5 bytes" });
    expect(rows("path")).toMatchObject({ "Sent over": "WebRTC, direct", "Round trip then": "12 ms", "Connection now": "WebRTC, direct, round trip 12 ms" });
    expect(rows("timing")).toMatchObject({ Composed: "2023-11-14T22:13:20.000Z", Sent: "2023-11-14T22:13:20.100Z", Receipt: "2023-11-14T22:13:20.142Z", "Receipt after": "42 ms", Attempts: "1 send" });
    expect(rows("wire")).toMatchObject({ Frame: "paired-message", Protocol: "chat/1", Plaintext: "5 bytes", "On the wire": "61 bytes" });
    expect(rows("crypto")).toMatchObject({ Channel: "WebRTC data channel: DTLS 1.2+ with SCTP", "Contact key pinned": PEER_KEY });
    expect(section("crypto")).toHaveTextContent("verified by comparing codes");
    expect(rows("delivery")).toMatchObject({ State: "Delivered (receipt received)", "Receipt id": "wireidwireidwireidwire" });
    // The keys shown are the public participation keys; no seed, token or signal is anywhere in it.
    expect(screen.getByTestId("message-details-keys-hint")).toHaveTextContent("Keys are never shown here.");
  });

  it("a text received through an Iroh relay names the relay", async () => {
    fakeEngine.on("messageDetails", () => textView({
      message: { id: "peer_x", wireId: "w", linkId: "link-1", sender: "peer", timestamp: 1_700_000_000_000, via: "datalink", kind: "text", textBytes: 5 },
      details: { received: { at: 1_700_000_000_300, path: "iroh/1", relayed: true, relays: ["relay.example"], rttMs: 80 }, wire: { frame: "paired-message", protocol: "chat/1", plaintextBytes: 5, wireBytes: 61 } },
    }));
    const { user } = bubble({ id: "peer_x", sender: "peer", delivery: undefined });
    await user.dblClick(screen.getByText("hello"));
    await waitFor(() => expect(screen.getByTestId("message-details")).toHaveAttribute("data-loaded", "yes"));
    expect(screen.getByTestId("message-details-summary")).toHaveTextContent("Message received live over Iroh through relay.example, encrypted end to end.");
    expect(rows("path")).toMatchObject({ "Received over": "Iroh through relay.example", Relay: "relay.example" });
    expect(rows("timing")).toMatchObject({ Received: "2023-11-14T22:13:20.300Z", "After composing": "300 ms (by the two devices' clocks)" });
    expect(rows("crypto")).toMatchObject({ Channel: "Iroh: QUIC with TLS 1.3 (raw public keys)" });
  });

  it("a text on the DHT floor: the envelope, its nonce and the record it went in", async () => {
    fakeEngine.on("messageDetails", () => textView({
      message: { id: "me_abc", wireId: "wireidwireidwireidwire", linkId: "link-1", sender: "me", timestamp: 1_700_000_000_000, via: "pkarr", delivery: "sent", kind: "text", textBytes: 5 },
      details: { sends: [{ at: 1_700_000_000_100, path: "dht", result: "sent" }], attempts: 1, sentAt: 1_700_000_000_100,
        wire: { frame: "_dm envelope", protocol: "dht-text/1", plaintextBytes: 5, wireBytes: 412 },
        dht: { seq: 7, issued: 1_700_000_000_100, expires: 1_700_000_300_100, packetBytes: 412, nonce: "n".repeat(32), recordKey: MY_KEY, records: ["_dm", "_dmk"] } },
    }));
    const { user } = bubble({ delivery: "sent" });
    await user.dblClick(screen.getByText("hello"));
    await waitFor(() => expect(screen.getByTestId("message-details")).toHaveAttribute("data-loaded", "yes"));
    expect(screen.getByTestId("message-details-summary")).toHaveTextContent("Message sent on the DHT, sealed end to end, waiting for the receipt.");
    expect(rows("dht")).toMatchObject({ "Record key": MY_KEY, Sequence: "7", "Signed packet": "412 bytes", Nonce: "n".repeat(32), Records: "_dm, _dmk" });
    expect(rows("crypto")).toMatchObject({ "Envelope cipher": "XSalsa20-Poly1305 (NaCl secretbox)" });
  });

  it("a queued text tells how many sends went without a receipt", async () => {
    fakeEngine.on("messageDetails", () => textView({
      message: { id: "me_abc", wireId: "w", linkId: "link-1", sender: "me", timestamp: 1_700_000_000_000, via: "datalink", delivery: "queued", resendUntil: 1_700_600_000_000, kind: "text", textBytes: 5 },
      details: { sends: [{ at: 1_700_000_000_100, path: "webrtc/1", relayed: false, result: "sent" }, { at: 1_700_000_020_100, path: "webrtc/1", relayed: false, result: "failed", error: "closed" }, { at: 1_700_000_050_100, path: "hyperdht/1", relayed: true, result: "sent" }], attempts: 3, sentAt: 1_700_000_050_100 },
    }));
    const { user } = bubble({ delivery: "queued", deliveryError: "No receipt received yet." });
    await user.dblClick(screen.getByText("hello"));
    await waitFor(() => expect(screen.getByTestId("message-details")).toHaveAttribute("data-loaded", "yes"));
    expect(screen.getByTestId("message-details-summary")).toHaveTextContent("Message sent 3 times over HyperDHT through a relay without a receipt. It goes again by itself.");
    expect(rows("path").Sends).toContain("WebRTC, direct (sent)");
    expect(rows("path").Sends).toContain("(failed: closed)");
    expect(rows("timing")).toMatchObject({ Attempts: "3 sends", "Sends again until": "2023-11-21T20:53:20.000Z" });
    expect(rows("delivery")).toMatchObject({ State: "Not confirmed yet, sends again by itself", Note: "No receipt received yet." });
  });

  it("a file: name, type, size, digest, protocol, chunks and where it is kept", async () => {
    fakeEngine.on("messageDetails", () => textView({
      message: { id: "me_1", linkId: "link-1", sender: "me", timestamp: 1_700_000_000_000, via: "datalink", kind: "file", textBytes: 10 },
      details: { sends: [{ at: 1_700_000_000_100, path: "webrtc/1", relayed: false, result: "sent" }], attempts: 1, sentAt: 1_700_000_000_100, completedAt: 1_700_000_004_000, receiptAt: 1_700_000_004_000,
        wire: { frame: "pf-offer + pf-data", protocol: "files/3", plaintextBytes: 3_000_000, chunks: 184, chunkBytes: 16_384 } },
      file: { id: "f1", name: "haunted house.bin", size: 3_000_000, mime: "application/octet-stream", digest: "ab".repeat(32), protocol: "files/3", state: "done", confirmed: 3_000_000, since: 1_700_000_000_100, storage: "opfs" },
    }));
    const { user } = bubble({ id: "me_1", text: "haunted house.bin", file: { id: "f1", name: "haunted house.bin", size: 3_000_000, mime: "application/octet-stream" }, delivery: undefined });
    await user.dblClick(screen.getByTestId("message-options").parentElement!.parentElement!);
    await waitFor(() => expect(screen.getByTestId("message-details")).toHaveAttribute("data-loaded", "yes"));
    expect(screen.getByTestId("message-details-kind")).toHaveTextContent("File");
    expect(screen.getByTestId("message-details-summary")).toHaveTextContent("File sent live over WebRTC, direct, encrypted end to end, receipt in 3.90 s.");
    expect(rows("file")).toMatchObject({ Name: "haunted house.bin", Type: "application/octet-stream", Size: "2.9 MB (3,000,000 bytes)", "SHA-256": "ab".repeat(32), Protocol: "files/3", Transfer: "done", Confirmed: "2.9 MB (3,000,000 bytes) durably stored", "Stored as": "a file in the origin's private file system" });
    expect(rows("wire")).toMatchObject({ Frame: "pf-offer + pf-data", Chunks: "184 × 16.0 KB (16,384 bytes)" });
    expect(rows("timing")).toMatchObject({ "Transfer completed": "2023-11-14T22:13:24.000Z" });
  });

  it("a voice message: codec, length, bitrate and its waveform", async () => {
    fakeEngine.on("messageDetails", () => textView({
      message: { id: "peer_v", linkId: "link-1", sender: "peer", timestamp: 1_700_000_000_000, via: "datalink", kind: "voice", textBytes: 10 },
      details: { received: { at: 1_700_000_000_500, path: "webrtc/1", relayed: false }, wire: { frame: "pf-start + pf-chunk", protocol: "files/2", plaintextBytes: 12_000, chunks: 1, chunkBytes: 16_384 }, completedAt: 1_700_000_001_000 },
      file: { id: "v1", name: "Voice message.webm", size: 12_000, mime: "audio/webm;codecs=opus", digest: "cd".repeat(32), protocol: "files/2", state: "done", transferred: 12_000, voice: { duration: 3_000, peaks: 64 } },
    }));
    const { user, container } = bubble({ id: "peer_v", sender: "peer", text: "Voice message.webm", delivery: undefined, file: { id: "v1", name: "Voice message.webm", size: 12_000, mime: "audio/webm;codecs=opus", voice: { duration: 3_000, peaks: new Array(64).fill(10) } } });
    await user.dblClick(container.querySelector("[data-message-row]")!);
    await waitFor(() => expect(screen.getByTestId("message-details")).toHaveAttribute("data-loaded", "yes"));
    expect(screen.getByTestId("message-details-kind")).toHaveTextContent("Voice message");
    expect(screen.getByTestId("message-details-summary")).toHaveTextContent("Voice message received live over WebRTC, direct, encrypted end to end.");
    expect(rows("voice")).toEqual({ Codec: "Opus in WebM", Length: "3.00 s", Bitrate: "32 kbit/s", Waveform: "64 peaks" });
    expect(rows("file")).toMatchObject({ Protocol: "files/2" });
  });

  it("a payment: id, kind, amount, rail, state and the invoice's digest, never the invoice or a token", async () => {
    fakeEngine.on("messageDetails", () => textView({
      message: { id: "me_p", linkId: "link-1", sender: "me", timestamp: 1_700_000_000_000, via: "datalink", kind: "payment", textBytes: 20 },
      details: { sends: [{ at: 1_700_000_000_100, path: "webrtc/1", relayed: false, result: "sent" }], attempts: 1, sentAt: 1_700_000_000_100 },
      payment: { id: "pay-1", kind: "request", direction: "out", amount: 2100, unit: "sat", state: "pending", method: "lightning", network: "lightning", provider: "cashu-mint", mint: "https://mint.example", createdAt: 1_700_000_000_000, invoiceDigest: "ef".repeat(32) },
    }));
    const { user, container } = bubble({ id: "me_p", text: "⚡ Requested 2,100 sats", paymentId: "pay-1", delivery: undefined });
    await user.dblClick(container.querySelector("[data-message-row]")!);
    await waitFor(() => expect(screen.getByTestId("message-details")).toHaveAttribute("data-loaded", "yes"));
    expect(screen.getByTestId("message-details-summary")).toHaveTextContent("Payment request sent live over WebRTC, direct, encrypted end to end.");
    expect(rows("payment")).toMatchObject({ "Payment id": "pay-1", Kind: "Request, outgoing", Amount: "2,100 sat", Rail: "lightning · lightning · cashu-mint", State: "pending", Mint: "https://mint.example", "Invoice SHA-256": "ef".repeat(32) });
    expect(screen.getByTestId("message-details")).not.toHaveTextContent(/lnbc|cashuA|cashuB/);
  });

  it("a held message: stored for the contact, picked up later", async () => {
    fakeEngine.on("messageDetails", () => textView({
      message: { id: "me_h", wireId: "w", linkId: "link-1", sender: "me", timestamp: 1_700_000_000_000, via: "hold", delivery: "delivered", kind: "text", textBytes: 5 },
      details: { sends: [{ at: 1_700_000_000_100, path: "hold", result: "sent" }], attempts: 1, sentAt: 1_700_000_000_100, heldAt: 1_700_000_000_100, receiptAt: 1_700_010_800_100,
        wire: { frame: "GHLD bundle", protocol: "hold/1", plaintextBytes: 5, wireBytes: 180 }, hold: { seq: 3, bytes: 180, expires: 1_700_604_800_000 } },
    }));
    const { user } = bubble({ id: "me_h" });
    await user.dblClick(screen.getByText("hello"));
    await waitFor(() => expect(screen.getByTestId("message-details")).toHaveAttribute("data-loaded", "yes"));
    expect(screen.getByTestId("message-details-summary")).toHaveTextContent("Message held in your storage, sealed for your contact, picked up 3 h 0 min later.");
    expect(rows("delivery")).toMatchObject({ "Held item": "#3 in the mailbox, 180 bytes sealed" });
    expect(rows("timing")).toMatchObject({ "Picked up after": "3 h 0 min" });
    expect(rows("crypto")).toMatchObject({ "Bundle cipher": "XSalsa20-Poly1305 (NaCl secretbox), GHLD bundle (hold/1)" });
  });

  it("a call event kept by the app alone says so, and shows the call", async () => {
    const { user, container } = bubble({ id: "system_call_1", sender: "system", text: "Video call ended", delivery: undefined, callEvent: { type: "call_ended", hasVideo: true, duration: 65_000 } }, { peerPubKey: "" });
    await user.dblClick(container.querySelector("[data-message-row]")!);
    await waitFor(() => expect(screen.getByTestId("message-details")).toHaveAttribute("data-loaded", "yes"));
    expect(fakeEngine.callsTo("messageDetails")).toEqual([]);
    expect(screen.getByTestId("message-details-summary")).toHaveTextContent("A note kept on this device only. Nothing was sent for it.");
    expect(rows("call")).toEqual({ Event: "ended", Video: "yes", Length: "1 min 5 s" });
    expect(rows("identity")).toMatchObject({ Kind: "Call event", Direction: "System" });
  });

  it("a group message names the group, the member and the epoch cipher", async () => {
    fakeEngine.on("messageDetails", () => ({
      message: { id: "g1", linkId: "group:g", sender: "peer", timestamp: 1_700_000_000_000, via: "datalink", member: PEER_KEY, kind: "text", textBytes: 5 },
      group: { id: "g", member: PEER_KEY, profile: "mesh" },
    }));
    const { user } = bubble({ id: "g1", sender: "peer", delivery: undefined }, { linkId: "group:g", peerPubKey: "" });
    await user.dblClick(screen.getByText("hello"));
    await waitFor(() => expect(screen.getByTestId("message-details")).toHaveAttribute("data-loaded", "yes"));
    expect(fakeEngine.callsTo("messageDetails")).toEqual([{ linkId: "group:g", messageId: "g1" }]);
    expect(rows("group")).toEqual({ "Group id": "g", Profile: "group-mesh/1", "Member key": PEER_KEY });
    expect(rows("crypto")).toMatchObject({ "Message cipher": "XChaCha20-Poly1305, the group's epoch key" });
  });
});

describe("copying", () => {
  it("an id copies whole on a click, and the whole view copies as JSON", async () => {
    fakeEngine.on("messageDetails", () => textView());
    const { user } = bubble();
    await user.dblClick(screen.getByText("hello"));
    await waitFor(() => expect(screen.getByTestId("message-details")).toHaveAttribute("data-loaded", "yes"));
    const row = section("identity")!.querySelector<HTMLElement>('[data-label="Sender key"]')!;
    expect(row).toHaveTextContent("mykeyz...32myke");
    await user.click(within(row).getByRole("button"));
    expect(await navigator.clipboard.readText()).toBe(MY_KEY);
    expect(row).toHaveTextContent("Copied");
    await user.click(screen.getByTestId("message-details-copy-all"));
    const json = JSON.parse(await navigator.clipboard.readText());
    expect(json).toMatchObject({ id: "me_abc", kind: "Text", identity: { "Message id": "me_abc", "Sender key": MY_KEY }, path: { "Sent over": "WebRTC, direct" }, engine: { link: { peerKey: PEER_KEY } } });
    expect(screen.getByTestId("message-details-copy-all")).toHaveTextContent("Copied");
  });
});

describe("the words", () => {
  it.each([
    [{ path: "webrtc/1", relayed: false }, "WebRTC, direct"],
    [{ path: "hyperdht/1", relayed: true, relays: ["a.example", "b.example"] }, "HyperDHT through a.example, b.example"],
    [{ path: "iroh/1", relayed: true }, "Iroh through a relay"],
    [{ path: "dht" }, "DHT floor (Pkarr)"],
    [{ path: "legacy-datalink" }, "WebRTC (compatibility chat)"],
  ] as [Parameters<typeof pathWords>[0], string][])("%j reads %s", (step, words) => expect(pathWords(step)).toBe(words));

  it("sizes and durations read at a glance, with the exact figure", () => {
    expect(formatBytes(999)).toBe("999 bytes");
    expect(formatBytes(2048)).toBe("2.0 KB (2,048 bytes)");
    expect(formatDuration(42)).toBe("42 ms");
    expect(formatDuration(3_456)).toBe("3.46 s");
    expect(formatDuration(125_000)).toBe("2 min 5 s");
  });

  it("says nothing it does not know", () => {
    const model = buildDetails(message({ delivery: undefined }), null);
    expect(model.sections.map(s => s.id)).toEqual(["identity", "timing"]);
    expect(model.summary).toBe("Message sent.");
  });
});
