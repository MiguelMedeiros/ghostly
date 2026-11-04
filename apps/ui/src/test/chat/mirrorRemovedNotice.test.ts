import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act } from "@testing-library/react";
import { MESSAGE_CHANGES_TICK_MS } from "@ghostly/browser/platform/engine";
import type { StoredMessage } from "@ghostly/browser/shared/types";
import { showPrivateNotification } from "../../lib/notifications";
import { getUnreadCount, loadSession, saveSession } from "../../lib/storage";
import { fakeEngine, linkView } from "../fakeEngine";

// covers: app.attention.notifications

/*
 * The Linux app keeps one notification per chat, and reading the chat takes it away. A text the contact deleted for
 * everyone before it was read left the chat, and its place in the unread count, but its notification stayed: the
 * chat read as having nothing new, and a click on it opened a chat with nothing new.
 */

// The real sync (the setup stubs it out).
vi.unmock("@ghostly/browser/platform/sync");

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(async (command: string, _args?: unknown): Promise<unknown> => {
    if (command === "native_notification_permission") return "granted";
    if (command === "native_private_notification") return true;
    return undefined;
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke, getVersion: async () => "0.4.0" }));

const NOW = Date.now();
const tick = () => act(() => new Promise((resolve) => setTimeout(resolve, MESSAGE_CHANGES_TICK_MS * 2)));
const posted = () => tauri.invoke.mock.calls.filter(([command]) => command === "native_private_notification").map(([, args]) => (args as { id: string }).id);
const cleared = () => tauri.invoke.mock.calls.filter(([command]) => command === "native_clear_notification").map(([, args]) => (args as { id: string }).id);

beforeEach(() => {
  (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {};
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15");
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  tauri.invoke.mockClear();
});
afterEach(() => {
  delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
  vi.restoreAllMocks();
});

/** A chat with `count` texts of the contact's, none read, and the notification they posted. */
async function chat(id: string, count: number) {
  const peer = id.repeat(52), linkId = `link-${id}`;
  const rows = Array.from({ length: count }, (_, i): StoredMessage => ({ linkId, id: `peer_${i}`, text: `secret ${i}`, sender: "peer", timestamp: NOW - (5 - i) * 1_000 }) as StoredMessage);
  saveSession({ id, profile: "paired-chat/1", mySeedB64: `seed-${id}`, peerPubKeyB64: peer, encKeyB64: "enc", messages: [], createdAt: NOW - 10_000 });
  fakeEngine.update({ links: [linkView({ id: linkId, peerPubKeyZ32: peer, profile: "paired-chat/1" })] });
  const { startSessionSync } = await import("@ghostly/browser/platform/sync");
  startSessionSync();
  fakeEngine.messages(linkId, rows);
  await tick();
  expect(getUnreadCount(loadSession(id)!)).toBe(count);
  await showPrivateNotification(`message:${linkId}:peer_0`, "New message", id, true);
  expect(posted()).toHaveLength(1);
  return { linkId, tag: posted()[0]! };
}

it("the contact deletes the chat's only unread text for everyone: its notification goes", async () => {
  const { linkId, tag } = await chat("a", 1);
  fakeEngine.emit({ kind: "message-changes", linkId, messages: [], deleted: ["peer_0"] });
  await tick();
  expect(getUnreadCount(loadSession("a")!)).toBe(0);
  expect(cleared()).toEqual([tag]);
});

it("a removal told by a whole list (no page heard it) takes it away too", async () => {
  const { linkId, tag } = await chat("b", 1);
  fakeEngine.messages(linkId, [], ["peer_0"]);
  await tick();
  expect(cleared()).toEqual([tag]);
});

it("one unread text still there keeps it", async () => {
  const { linkId } = await chat("c", 2);
  fakeEngine.emit({ kind: "message-changes", linkId, messages: [], deleted: ["peer_0"] });
  await tick();
  expect(getUnreadCount(loadSession("c")!)).toBe(1);
  expect(cleared()).toEqual([]);
});
