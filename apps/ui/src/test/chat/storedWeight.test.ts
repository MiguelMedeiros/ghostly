import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, ChatSession } from "../../lib/types";

// covers: chat.paired.storage

/*
 * A paired chat's stored copy kept its last `STORED_MESSAGES` rows whole, though the engine keeps them: a feed's link
 * thumbnails (~25 K characters each) and an agent's texts edited 20 times rode in it, and every message that came wrote
 * and parsed megabytes again. The copy stays about as long as any chat's; the chat still has every thumbnail and edit.
 */

const NOW = 1_800_000_000_000;
const N = 5_000;
const THUMB = `data:image/jpeg;base64,/9j/${"A".repeat(25_200)}`;

const storage = () => import("../../lib/storage");

function rows(kind: "links" | "edits"): ChatMessage[] {
  return Array.from({ length: N }, (_, i) => {
    const m: ChatMessage = { id: `peer_${i}`, text: `message ${i}`, sender: "peer", timestamp: NOW + i };
    // 40 thumbnails among the last 200 rows; 25 texts edited 20 times.
    if (kind === "links" && i % 5 === 1) m.preview = { u: `https://news.example/${i}`, t: `Story ${i}`, s: "News", i: THUMB };
    if (kind === "edits" && i % 8 === 1) {
      const version = (k: number) => `Working on #${i}: ${"step ".repeat(240)}${k}`;
      m.text = version(20);
      m.edit = { seq: 20, at: NOW + i + 1, history: Array.from({ length: 19 }, (_, k) => ({ at: NOW + i, text: version(k + 1) })) };
    }
    return m;
  });
}

const storedRaw = () => localStorage.getItem("ghostly_chat")!;

async function arrival(kind: "links" | "edits") {
  const { addMessage, saveSession, setEngineMessages } = await storage();
  const history = rows(kind);
  const session: ChatSession = { id: "chat", profile: "paired-chat/1", mySeedB64: "seed", peerPubKeyB64: "p".repeat(52), encKeyB64: "enc", messages: history, createdAt: NOW };
  setEngineMessages("chat", new Set(history.map((m) => m.id)));
  saveSession(session);
  addMessage("chat", { id: "peer_new", text: "back?", sender: "peer", timestamp: NOW + N });
  return history;
}

describe("a long chat whose last rows are heavy", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it.each(["links", "edits"] as const)("keeps its stored copy about as long as any chat's (%s)", async (kind) => {
    const { loadSession } = await storage();
    const history = await arrival(kind);
    expect(storedRaw().length).toBeLessThan(250_000);
    const stored = JSON.parse(storedRaw()) as ChatSession;
    expect(stored.messages[stored.messages.length - 1]!.id).toBe("peer_new");
    expect(stored.older! + stored.messages.length).toBe(N + 1);
    // This page's chat has every row, heavy parts included.
    const chat = loadSession("chat")!;
    expect(chat.messages).toHaveLength(N + 1);
    expect(chat.messages.slice(0, N)).toEqual(history);
  });

  it("shows the thumbnails again once the engine's history is back after a reload", async () => {
    const history = await arrival("links");
    vi.resetModules();
    const again = await storage();
    again.setEngineMessages("chat", new Set([...history.map((m) => m.id), "peer_new"]));
    expect(again.loadSession("chat")!.messages.length).toBeLessThan(N + 1);
    again.addMessages("chat", history, true);
    const chat = again.loadSession("chat")!;
    expect(chat.messages).toHaveLength(N + 1);
    expect(chat.messages.filter((m) => m.preview?.i === THUMB)).toHaveLength(N / 5);
    expect(storedRaw().length).toBeLessThan(250_000);
  });
});
