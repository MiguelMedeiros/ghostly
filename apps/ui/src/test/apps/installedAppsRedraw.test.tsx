import { Profiler } from "react";
import { act, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appCardId, statusCardText, type AppCard } from "@ghostly/core";
import type { InstalledAppView } from "@ghostly/browser/engine/apps";
import { MessageBubble } from "../../components/MessageBubble";
import { Sidebar } from "../../components/Sidebar";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { forgetInstalledApps, refreshInstalledApps } from "../../lib/apps/installed";
import { saveSession } from "../../lib/storage";
import type { ChatMessage, ChatSession } from "../../lib/types";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";

// covers: apps.chat.card

/**
 * The installed apps are read again after every update check (opening the Apps page starts one) and every install or
 * uninstall. Only what names an app draws again then: a message or a chat row with no app card shows nothing of the list.
 */

const KEY = "yz7moxucbd4u8aqtk5ir8khn4emft7zskr7qo7x876ntwxfiegoo";
const REF = `${KEY}/notes`;
const DIGEST = "ExPDNDfgZ_QT1mf4KwxD-xeFAYukL50YWZ1YuFsKkp4";
const URL_ = "https://raw.githubusercontent.com/ana/notes/HEAD/app.ghostlyapp";
const NOTES = {
  ref: REF, name: "notes", publisher: KEY, fingerprint: "yz7m oxuc bd4u 8aqt", title: "Private Notes", tagline: "Notes",
  version: "3.1.0", sequence: 7, digest: DIGEST, permissions: ["chat"], view: "chat", from: URL_, icon: false, installedAt: 1, updatedAt: 1,
  run: { status: "ok" }, listedBy: [], unknownPublisher: true,
} as unknown as InstalledAppView;
const CARD: AppCard = { kind: "app", id: appCardId(REF), ref: REF, digest: DIGEST, sequence: 7, title: "Chess", version: "1.0.0", url: URL_, opened: true };
const NOW = Date.now();
const textOf = (id: string): ChatMessage => ({ id, text: `hello ${id}`, sender: "peer", timestamp: NOW });
const session = (id: string, messages: ChatMessage[]) => ({ id, profile: "paired-chat/1", mySeedB64: "seed-a", peerPubKeyB64: id.padEnd(52, "a"), encKeyB64: "enc", nick: id, createdAt: NOW, messages }) as unknown as ChatSession;

/** The list as an update check leaves it, with nothing in it that changed for these. */
const readAgain = () => act(() => refreshInstalledApps());

describe("the installed apps read again", () => {
  beforeEach(() => {
    forgetInstalledApps();
    fakeEngine.on("appList", () => [{ ...NOTES }]);
  });
  afterEach(() => forgetInstalledApps());

  it("draws no message without an app card", async () => {
    await refreshInstalledApps();
    let draws = 0;
    renderApp(<Profiler id="messages" onRender={() => { draws++; }}>
      {Array.from({ length: 50 }, (_, i) => <MessageBubble key={i} message={textOf(`m${i}`)} peerNick="Alice" peerPubKey="peer" />)}
    </Profiler>);
    const before = draws;
    await readAgain();
    await readAgain();
    expect(draws - before).toBe(0);
  });

  it("draws no chat row whose last message is no app card", async () => {
    for (let i = 0; i < 50; i++) saveSession(session(`chat${i}`, [textOf(`m${i}`)]));
    await refreshInstalledApps();
    let draws = 0;
    renderApp(<Profiler id="rows" onRender={() => { draws++; }}><UpdateProvider><Sidebar /></UpdateProvider></Profiler>);
    expect(screen.getAllByTestId("chat-row").length).toBeGreaterThanOrEqual(50);
    // What the page still settles after its first draw is not counted: every read after this one is a new list too.
    await readAgain();
    const before = draws;
    await readAgain();
    await readAgain();
    expect(draws - before).toBe(0);
  });

  it("still names an app that changed in a row with its card", async () => {
    const message = { id: "m1", text: statusCardText(CARD), card: CARD, sender: "peer", timestamp: NOW } as ChatMessage;
    saveSession(session("ana", [message]));
    renderApp(<UpdateProvider><Sidebar /></UpdateProvider>);
    const row = screen.getAllByTestId("chat-row").find((r) => within(r).getByTestId("chat-row-name").textContent === "ana")!;
    await waitFor(() => expect(within(row).getByTestId("chat-row-preview")).toHaveTextContent(/^🧩 App: Private Notes 3\.1\.0$/));
    fakeEngine.on("appList", () => [{ ...NOTES, version: "3.2.0" }]);
    await readAgain();
    expect(within(row).getByTestId("chat-row-preview")).toHaveTextContent(/^🧩 App: Private Notes 3\.2\.0$/);
  });
});
