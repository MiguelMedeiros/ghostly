import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PinnedBar } from "../../components/chat/PinnedBar";
import { messageSnippet, quoteFor, replyIndex } from "../../lib/replies";
import type { ChatMessage } from "../../lib/types";
import { locales } from "../../locales";
import { translateWith } from "../../locales/translate";
import { renderApp } from "../render";

// covers: chat.replies, chat.pins

/**
 * A voice message's or a video's text is kept in English ("🎤 Voice message (0:07)", `fileMessageText`): where it is
 * quoted or pinned it reads in the reader's language, as the chat list already shows it.
 */
const pt = translateWith(locales.pt, "pt");
const WIRE = "V".repeat(22);
const voice: ChatMessage = { id: `peer_${WIRE}`, text: "🎤 Voice message (0:07)", sender: "peer", timestamp: 1_700_000_000_000,
  file: { id: "chat-1-in-voice", name: "Voice message.webm", size: 9_000, mime: "audio/webm", voice: { duration: 7_000 } } };
const video: ChatMessage = { id: `peer_${"W".repeat(22)}`, text: "🎬 Video (0:04)", sender: "peer", timestamp: 1_700_000_001_000,
  file: { id: "chat-1-in-video", name: "clip.mp4", size: 90_000, mime: "video/mp4", video: { duration: 4_000, width: 640, height: 360 } } };

describe("a voice message or a video quoted or pinned, in Portuguese", () => {
  it("the reply bar's and the reply's quote say it in the reader's language", () => {
    expect(messageSnippet(voice, pt)).toBe("🎤 Mensagem de voz (0:07)");
    expect(messageSnippet(video, pt)).toBe(pt("chat.preview.video", { duration: "0:04" }));
    const quote = quoteFor({ id: WIRE, from: "peer", messageId: voice.id }, replyIndex([voice]), () => "Ana", pt);
    expect(quote.snippet).toBe("🎤 Mensagem de voz (0:07)");
    // A file that is neither keeps its own line, and English stays as it was.
    expect(messageSnippet({ text: "📎 notes.txt", file: { id: "f", name: "notes.txt", size: 3, mime: "text/plain" } }, pt)).toBe("📎 notes.txt");
    expect(messageSnippet(voice)).toBe("🎤 Voice message (0:07)");
  });

  it("the pinned bar says it in the reader's language", () => {
    renderApp(<PinnedBar pin={{ id: WIRE, messageId: voice.id } as never} index={replyIndex([voice])} />, { language: "pt" });
    expect(screen.getByTestId("pinned-snippet")).toHaveTextContent("🎤 Mensagem de voz (0:07)");
  });
});
