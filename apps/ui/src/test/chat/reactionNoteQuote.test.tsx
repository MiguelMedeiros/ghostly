import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { appCardId, type AppCard } from "@ghostly/core";
import type { GroupMemberView, ReactionNote } from "@ghostly/browser/shared/types";
import { Sidebar } from "../../components/Sidebar";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { forgetInstalledApps } from "../../lib/apps/installed";
import { reactionNoteText } from "../../lib/reactions";
import { saveSession } from "../../lib/storage";
import type { ChatMessage, ChatSession } from "../../lib/types";
import { loadLocale, translatorFor } from "../../locales";
import { fakeEngine, groupView, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: chat.reactions, groups.reactions, chats.list.rows

/*
 * The chat list's reaction line quotes a voice message, a video or an app card as its quotes and the pinned bar do: in
 * the reader's language, never the English its text keeps for an older app, and never an app card's link. From its row
 * when the chat holds it; else from what the engine's note says the message is; a note from before that, its snippet.
 */

const URL = "https://raw.githubusercontent.com/ana/chess/HEAD/app.ghostlyapp";
const REF = "yz7moxucbd4u8aqtk5ir8khn4emft7zskr7qo7x876ntwxfiegoo/chess";
const CARD: AppCard = { kind: "app", id: appCardId(REF), ref: REF, digest: "ExPDNDfgZ_QT1mf4KwxD-xeFAYukL50YWZ1YuFsKkp4", sequence: 7, title: "Chess", version: "1.2.0", url: URL, opened: true };
/** The texts the history keeps for them (`fileMessageText`, `statusCardText`), and the note's line of each as dev made it. */
const VOICE_TEXT = "🎤 Voice message (0:07)";
const APP_TEXT = `🧩 Opened Chess 1.2.0 in this chat (Ghostly app)\n${URL}`;
const voiceRow: ChatMessage = { id: "peer_voice", text: VOICE_TEXT, sender: "peer", timestamp: 1, file: { id: "f1", name: "voice.webm", size: 9, mime: "audio/webm", voice: { duration: 7_000, peaks: [1, 2] } } } as ChatMessage;
const appRow: ChatMessage = { id: "me_app", text: APP_TEXT, sender: "me", timestamp: 2, card: CARD };
const note = (patch: Partial<ReactionNote>): ReactionNote => ({ at: 10, by: "me", emoji: "❤️", snippet: VOICE_TEXT, mine: false, ...patch });

let pt: ReturnType<typeof translatorFor>;
beforeAll(async () => {
  await loadLocale("pt");
  pt = translatorFor("pt");
});
beforeEach(() => forgetInstalledApps());
afterEach(() => forgetInstalledApps());

describe("reactionNoteText in Portuguese", () => {
  it("with the message's row: a voice message and an app card read as their quotes do, with no link", () => {
    expect(reactionNoteText(note({ message: voiceRow.id }), "Ana", pt, { row: voiceRow })).toBe('Você reagiu com ❤️ a "🎤 Mensagem de voz (0:07)"');
    // Where the chat draws the card: its line. Where it draws its text (a group, Apps off): that text, without the link.
    const app = note({ by: "peer", snippet: `🧩 Opened Chess 1.2.0 in this chat (Ghostly app) ${URL}`, mine: true, message: appRow.id });
    expect(reactionNoteText(app, "Ana", pt, { row: appRow, appCards: true })).toBe('Ana reagiu com ❤️ a "🧩 App: Chess 1.2.0"');
    const asText = reactionNoteText(app, "Ana", pt, { row: appRow, appCards: false });
    expect(asText).toBe('Ana reagiu com ❤️ a "🧩 Opened Chess 1.2.0 in this chat (Ghostly app)"');
    expect(asText).not.toContain("https://");
  });

  it("without the row: what the note says its message is, and a note from before that says its snippet", () => {
    expect(reactionNoteText(note({ kind: { voice: 7_000 } }), "Ana", pt)).toBe('Você reagiu com ❤️ a "🎤 Mensagem de voz (0:07)"');
    expect(reactionNoteText(note({ snippet: "🎬 Video (0:12)", kind: { video: 12_000 } }), "Ana", pt)).toBe('Você reagiu com ❤️ a "🎬 Vídeo (0:12)"');
    const app = note({ snippet: "🧩 Opened Chess 1.2.0 in this chat (Ghostly app)", kind: { app: { ref: REF, title: "Chess", version: "1.2.0" } } });
    expect(reactionNoteText(app, "Ana", pt, { appCards: true })).toBe('Você reagiu com ❤️ a "🧩 App: Chess 1.2.0"');
    expect(reactionNoteText(app, "Ana", pt, { appCards: false })).toBe('Você reagiu com ❤️ a "🧩 Opened Chess 1.2.0 in this chat (Ghostly app)"');
    // A plain text, or a note kept from before the engine said what its message is.
    expect(reactionNoteText(note({ snippet: "almoço?" }), "Ana", pt)).toBe('Você reagiu com ❤️ a "almoço?"');
    expect(reactionNoteText(note({}), "Ana", pt, { row: undefined })).toBe(`Você reagiu com ❤️ a "${VOICE_TEXT}"`);
  });
});

describe("the chat list's rows in Portuguese", () => {
  const NOW = Date.now();
  const key = (i: number) => `p${i}`.padEnd(52, "a");
  const member = (i: number): GroupMemberView => ({ key: key(100 + i), role: i === 0 ? "admin" : "member", me: i === 0, nick: `Member ${i}`, online: true, missing: 0 });

  it("a 1:1 chat's reaction to a voice message, and a group's to one the list has no row of", async () => {
    const session: ChatSession = { id: "chat-1", profile: "paired-chat/1", mySeedB64: "seed-1", peerPubKeyB64: key(1), encKeyB64: "enc", nick: "Ana", createdAt: NOW - 600_000,
      lastSyncAt: NOW - 30_000, messages: [{ ...voiceRow, timestamp: NOW - 60_000 }], lastReaction: note({ by: "peer", at: NOW - 30_000, mine: true, message: voiceRow.id }) };
    saveSession(session);
    fakeEngine.update({ links: [linkView({ id: "link-1", peerPubKeyZ32: key(1), lastSyncAt: NOW - 30_000 })], groupsLoaded: true, groups: [groupView({
      id: "g-1", name: "Group", status: "active", lastMessageAt: NOW - 60_000, myKey: key(100), members: [member(0), member(1)],
      lastReaction: note({ by: key(101), at: NOW - 30_000, snippet: "🎬 Video (0:12)", kind: { video: 12_000 }, message: `${key(101)}:0:1` }),
    })] });
    renderApp(<UpdateProvider><Sidebar /></UpdateProvider>, { language: "pt" });
    await waitFor(() => expect(within(screen.getByTestId("chat-row")).getByTestId("chat-row-preview")).toHaveTextContent('reagiu com ❤️ a "🎤 Mensagem de voz (0:07)"'));
    expect(screen.getByTestId("group-row-note")).toHaveTextContent('Member 1 reagiu com ❤️ a "🎬 Vídeo (0:12)"');
  });
});
