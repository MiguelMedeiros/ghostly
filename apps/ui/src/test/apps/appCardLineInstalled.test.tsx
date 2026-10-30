import { act, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appCardId, statusCardText, type AppCard } from "@ghostly/core";
import type { InstalledAppView } from "@ghostly/browser/engine/apps";
import type { StoredMessage } from "@ghostly/browser/shared/types";
import { Sidebar } from "../../components/Sidebar";
import { ANNOUNCE_WINDOW_MS, MessageAnnouncer, type Announceable } from "../../components/chat/MessageAnnouncer";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { forgetInstalledApps, refreshInstalledApps } from "../../lib/apps/installed";
import { messageSnippet } from "../../lib/replies";
import { saveSession } from "../../lib/storage";
import type { ChatMessage, ChatSession } from "../../lib/types";
import { Saved } from "../../pages/Saved";
import { fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: apps.chat.card

/*
 * An app card's line (the chat list, a quote and the pinned bar, Saved, the screen reader) names an app installed here
 * as its bubble does: the installed app's own title and version, never the sender's words for it. Only an app not
 * installed here reads with the card's own title.
 */

const KEY = "yz7moxucbd4u8aqtk5ir8khn4emft7zskr7qo7x876ntwxfiegoo";
const REF = `${KEY}/notes`;
const DIGEST = "ExPDNDfgZ_QT1mf4KwxD-xeFAYukL50YWZ1YuFsKkp4";
const URL_ = "https://raw.githubusercontent.com/ana/notes/HEAD/app.ghostlyapp";
// Installed here as "Private Notes 3.1.0"; the contact's card names the same ref "Chess 1.0.0".
const NOTES = {
  ref: REF, name: "notes", publisher: KEY, fingerprint: "yz7m oxuc bd4u 8aqt", title: "Private Notes", tagline: "Notes",
  version: "3.1.0", sequence: 7, digest: DIGEST, permissions: ["chat"], view: "chat", from: URL_, icon: false, installedAt: 1, updatedAt: 1,
  run: { status: "ok" }, listedBy: [], unknownPublisher: true,
} as unknown as InstalledAppView;
const CARD: AppCard = { kind: "app", id: appCardId(REF), ref: REF, digest: DIGEST, sequence: 7, title: "Chess", version: "1.0.0", url: URL_, opened: true };
const NOW = Date.now();
const MESSAGE = { id: "m1", text: statusCardText(CARD), card: CARD, sender: "peer", timestamp: NOW } as ChatMessage;
const OTHER: AppCard = { ...CARD, id: appCardId(`${KEY}/chess`), ref: `${KEY}/chess` };

describe("an app card for an app installed here", () => {
  beforeEach(() => {
    forgetInstalledApps();
    fakeEngine.on("appList", () => [NOTES]);
  });
  afterEach(() => forgetInstalledApps());

  it("the chat list row names the installed app, read when the row shows", async () => {
    saveSession({ id: "a", profile: "paired-chat/1", mySeedB64: "seed-a", peerPubKeyB64: "a".repeat(52), encKeyB64: "enc", nick: "Ana", createdAt: NOW, messages: [MESSAGE] } as unknown as ChatSession);
    renderApp(<UpdateProvider><Sidebar /></UpdateProvider>);
    const row = screen.getAllByTestId("chat-row").find((r) => within(r).getByTestId("chat-row-name").textContent === "Ana")!;
    await waitFor(() => expect(within(row).getByTestId("chat-row-preview")).toHaveTextContent(/^🧩 App: Private Notes 3\.1\.0$/));
  });

  it("a quote and the pinned bar name the installed app; one not installed here keeps the card's title", async () => {
    await refreshInstalledApps();
    expect(messageSnippet(MESSAGE)).toBe("🧩 App: Private Notes 3.1.0");
    expect(messageSnippet({ ...MESSAGE, card: OTHER })).toBe("🧩 App: Chess 1.0.0");
  });

  it("Saved names the installed app", async () => {
    saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: "peerkeyalice", encKeyB64: "a2V5", messages: [], createdAt: NOW, nick: "Alice" });
    const message: StoredMessage = { linkId: "link-1", id: "peer_1", text: MESSAGE.text, card: CARD, sender: "peer", timestamp: NOW - 60_000, via: "datalink" };
    const rendered = renderApp(<Saved />, { route: "/saved" });
    rendered.engine.on("savedMessages", () => [{ savedAt: NOW, message }])
      .setState({ links: [linkView({ id: "link-1", peerPubKeyZ32: "peerkeyalice", peerNick: "Alice" })] });
    await waitFor(() => expect(screen.getByTestId("saved-text")).toHaveTextContent(/^🧩 App: Private Notes 3\.1\.0$/));
  });

  it("the screen reader's line names the installed app", async () => {
    await refreshInstalledApps();
    vi.useFakeTimers();
    try {
      const nameOf = () => "Ana";
      const history: Announceable[] = [{ id: "h1", sender: "peer", text: "hi" }];
      const view = renderApp(<MessageAnnouncer chat="c" messages={history} nameOf={nameOf} />);
      view.rerender(<MessageAnnouncer chat="c" messages={[...history, { id: "m1", sender: "peer", text: MESSAGE.text, card: CARD }]} nameOf={nameOf} />);
      act(() => { vi.advanceTimersByTime(ANNOUNCE_WINDOW_MS); });
      expect(screen.getByTestId("chat-announcement")).toHaveTextContent(/^Ana: 🧩 App: Private Notes 3\.1\.0$/);
    } finally { vi.useRealTimers(); }
  });
});
