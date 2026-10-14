import type { ReactNode } from "react";
import { act, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "../../components/Sidebar";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { resetAppBadge, setAppBadgeTarget, useAppBadge } from "../../lib/appBadge";
import { addMessages, saveSession } from "../../lib/storage";
import type { ChatMessage } from "../../lib/types";
import { renderApp } from "../render";

// covers: app.attention.badge

/*
 * A message arriving in a long chat had the chat list and the app's badge each parse the chat's stored copy again (and
 * merge it with the messages it leaves out), one after the other on the same `session-updated`. They read the chats
 * through one cache: a chat that changed is read once for both.
 */

const PEER = "peer".padEnd(52, "p");
const T = Date.now() - 600_000;
const theirs = (i: number): ChatMessage => ({ id: `peer_${i}`, sender: "peer", text: `message ${i}`, timestamp: T + i });

function AppIcon({ children }: { children: ReactNode }) {
  useAppBadge();
  return children;
}

afterEach(() => { setAppBadgeTarget(null); vi.restoreAllMocks(); });

describe("a message arriving in a chat", () => {
  it("has the chat list and the app's badge read the chat once between them", async () => {
    saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", label: "Ana", messages: Array.from({ length: 300 }, (_, i) => theirs(i)), createdAt: T - 1000 });
    const icon: number[] = [];
    resetAppBadge();
    setAppBadgeTarget({ setAppBadge: async (count) => { icon.push(count ?? 0); }, clearAppBadge: async () => { icon.push(0); } });
    renderApp(<UpdateProvider><AppIcon><Sidebar /></AppIcon></UpdateProvider>);
    await screen.findByText("message 299");

    act(() => void addMessages("chat-1", [theirs(300)]));
    // Each read of the chat's stored copy, from here on.
    const parse = JSON.parse;
    let reads = 0;
    vi.spyOn(JSON, "parse").mockImplementation((text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
      if (typeof text === "string" && text.includes('"id":"chat-1"') && text.includes('"messages"')) reads++;
      return parse(text, reviver);
    });
    act(() => void window.dispatchEvent(new Event("session-updated")));
    await screen.findByText("message 300");
    expect(icon[icon.length - 1]).toBe(301);
    expect(reads).toBe(1);
  });
});
