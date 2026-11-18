import { act, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { describe, expect, it } from "vitest";
import { PinnedBar } from "../../components/chat/PinnedBar";
import { replyIndex, messageSnippet, quoteFor, sentReply } from "../../lib/replies";
import type { ChatMessage } from "../../lib/types";
import { renderApp } from "../render";
import { ReplyBar, ReplyQuote } from "../../components/chat/ReplyQuote";
import { previewText } from "../../lib/chatList";
import { LOCALES as locales } from "../i18n/locales";
import { translateWith } from "../../locales/translate";

// covers: chat.pins
describe("the pinned message's bar, Unpin and a phone", () => {
  /**
   * ✕ on the pinned message's bar takes the whole bar away, itself included. Pressed from the keyboard, the focus went
   * with it to the page, and the next Tab started from the top: it goes to the chat's ⋮ instead.
   */
  const WIRE = "P".repeat(22);
  const message: ChatMessage = { id: `peer_${WIRE}`, text: "the door code is 4321", sender: "peer", timestamp: 1_700_000_000_000 };
  const index = replyIndex([message]);

  function Chat() {
    const [pinned, setPinned] = useState(true);
    const options = useRef<HTMLButtonElement>(null);
    return (
      <>
        <button ref={options} data-testid="chat-options">⋮</button>
        <PinnedBar pin={pinned ? ({ id: WIRE, messageId: message.id } as never) : undefined} index={index} onUnpin={() => setPinned(false)} returnFocus={options} />
        <textarea data-testid="composer" />
        <button data-testid="unpin-elsewhere" onClick={() => setPinned(false)}>unpinned by the other side</button>
      </>
    );
  }

  describe("Unpin on the pinned message's bar, from the keyboard", () => {
    it("leaves the focus on the chat's ⋮, not on the page", () => {
      renderApp(<Chat />);
      const unpin = screen.getByTestId("pinned-unpin");
      unpin.focus();
      act(() => unpin.click());
      expect(screen.queryByTestId("pinned-bar")).toBeNull();
      expect(document.activeElement).toBe(screen.getByTestId("chat-options"));
    });

    it("leaves alone a focus that is elsewhere as the bar goes", () => {
      renderApp(<Chat />);
      const composer = screen.getByTestId("composer");
      composer.focus();
      act(() => screen.getByTestId("unpin-elsewhere").click());
      expect(screen.queryByTestId("pinned-bar")).toBeNull();
      expect(document.activeElement).toBe(composer);
    });

    // Unpinned by the other side (a contact, a group's admin) while the focus is on the bar's line or its ⓘ: the bar goes
    // with the focus on it, which fell to the page.
    it.each(["pinned-open", "pinned-info"])("leaves the focus on the chat's ⋮ when the other side unpins with the focus on %s", (id) => {
      renderApp(<Chat />);
      screen.getByTestId(id).focus();
      act(() => screen.getByTestId("unpin-elsewhere").click());
      expect(screen.queryByTestId("pinned-bar")).toBeNull();
      expect(document.activeElement).toBe(screen.getByTestId("chat-options"));
    });

    it("takes no focus when the pin goes with the focus on the page already", () => {
      renderApp(<Chat />);
      act(() => screen.getByTestId("unpin-elsewhere").click());
      expect(screen.queryByTestId("pinned-bar")).toBeNull();
      expect(document.activeElement).toBe(document.body);
    });
  });

  describe("the pinned message's bar on a phone", () => {
    it("has a 44 px ⓘ and ✕, and the desktop keeps its 32 px", () => {
      renderApp(<Chat />);
      for (const id of ["pinned-info", "pinned-unpin"]) expect(screen.getByTestId(id)).toHaveClass("w-8", "h-8", "max-md:w-11", "max-md:h-11");
    });
  });
});

// covers: chat.pins groups.pins
describe("the pinned message's line, in the other script's direction", () => {
  /**
   * The pinned bar's line takes its direction from the message, as the reply bar's does: a Latin message in an Arabic
   * app (or an Arabic one in an English app) is cut at its end. In the page's direction it lost its start instead
   * ("… to cut on a narrow phone"). The 1:1 chat and the group page both draw this same bar.
   */
  const WIRE = "P".repeat(22);
  const pin = { id: WIRE, messageId: `peer_${WIRE}` } as never;

  function bar(text: string) {
    const message: ChatMessage = { id: `peer_${WIRE}`, text, sender: "peer", timestamp: 1_700_000_000_000 };
    return <PinnedBar pin={pin} index={replyIndex([message])} />;
  }

  it("a Latin message in an Arabic app takes its own direction", () => {
    renderApp(bar("A long message from Alice that wraps over a few lines to cut on a narrow phone"), { language: "ar" });
    const snippet = screen.getByTestId("pinned-snippet");
    expect(snippet).toHaveAttribute("dir", "auto");
    expect(snippet).toHaveClass("truncate");
  });

  it("an Arabic message in an English app takes its own direction", () => {
    renderApp(bar("رسالة طويلة من أليس تمتد على عدة أسطر لتقطع على هاتف ضيق"), { language: "en" });
    expect(screen.getByTestId("pinned-snippet")).toHaveAttribute("dir", "auto");
  });

  it("the line for a message not in this chat's history takes its own direction too", () => {
    renderApp(<PinnedBar pin={pin} index={replyIndex([])} />, { language: "ar" });
    expect(screen.getByTestId("pinned-snippet")).toHaveAttribute("dir", "auto");
  });
});

// covers: chat.replies chat.pins
describe("a spoiler where its message is quoted or pinned", () => {
  /**
   * A spoiler stays covered until its reader taps it in the bubble. A reply's quote, the reply bar, the pinned bar and
   * the line a reply sends showed its words, markers and all; they read it as the chat list does: ▒▒▒.
   */
  const WIRE = "S".repeat(22);
  const TEXT = "Spoiler: ||the butler did it||";
  const message: ChatMessage = { id: `peer_${WIRE}`, text: TEXT, sender: "peer", timestamp: 1_700_000_000_000 };
  const index = replyIndex([message]);

  it("the chat list covers it (what the others follow)", () => {
    expect(previewText(TEXT)).toBe("Spoiler: ▒▒▒");
  });

  it("the quote under a reply covers it", () => {
    const quote = quoteFor({ id: WIRE, snippet: "", from: "peer", messageId: message.id }, index, () => "Alice");
    renderApp(<ReplyQuote quote={quote} />);
    expect(screen.getByTestId("reply-quote-snippet")).toHaveTextContent(/^Spoiler: ▒▒▒$/);
  });

  it("the reply bar covers it", () => {
    renderApp(<ReplyBar name="Alice" snippet={messageSnippet(message)} mine={false} onCancel={() => {}} />);
    expect(screen.getByTestId("reply-quote-snippet")).toHaveTextContent(/^Spoiler: ▒▒▒$/);
  });

  it("the pinned bar covers it", () => {
    renderApp(<PinnedBar pin={{ id: WIRE, messageId: message.id } as never} index={index} />);
    expect(screen.getByTestId("pinned-snippet")).toHaveTextContent(/^Spoiler: ▒▒▒$/);
  });

  it("the line a reply sends covers it, so the contact's app never shows it either", () => {
    expect(sentReply(message)?.snippet).toBe("Spoiler: ▒▒▒");
  });

  it("other formatting in the line stays as it was", () => {
    expect(messageSnippet({ text: "**bold** and ~~gone~~" })).toBe("**bold** and ~~gone~~");
  });
});

// covers: chat.replies, chat.pins
describe("a voice message or a video quoted or pinned, in Portuguese", () => {
  /**
   * A voice message's or a video's text is kept in English ("🎤 Voice message (0:07)", `fileMessageText`): where it is
   * quoted or pinned it reads in the reader's language, as the chat list already shows it.
   */
  const pt = translateWith(locales.pt, "pt");
  const WIRE = "V".repeat(22);
  const voice: ChatMessage = { id: `peer_${WIRE}`, text: "🎤 Voice message (0:07)", sender: "peer", timestamp: 1_700_000_000_000,
    file: { id: "chat-1-in-voice", name: "Voice message.webm", size: 9_000, mime: "audio/webm", voice: { duration: 7_000, peaks: [] } } };
  const video: ChatMessage = { id: `peer_${"W".repeat(22)}`, text: "🎬 Video (0:04)", sender: "peer", timestamp: 1_700_000_001_000,
    file: { id: "chat-1-in-video", name: "clip.mp4", size: 90_000, mime: "video/mp4", video: { duration: 4_000, width: 640, height: 360 } } };

  it("the reply bar's and the reply's quote say it in the reader's language", () => {
    expect(messageSnippet(voice, pt)).toBe("🎤 Mensagem de voz (0:07)");
    expect(messageSnippet(video, pt)).toBe(pt("chat.preview.video", { duration: "0:04" }));
    const quote = quoteFor({ id: WIRE, snippet: "", from: "peer", messageId: voice.id }, replyIndex([voice]), () => "Ana", pt);
    expect(quote.snippet).toBe("🎤 Mensagem de voz (0:07)");
    // A file that is neither keeps its own line, and English stays as it was.
    expect(messageSnippet({ text: "📎 notes.txt", file: { id: "f", name: "notes.txt", size: 3, mime: "text/plain" } }, pt)).toBe("📎 notes.txt");
    expect(messageSnippet(voice)).toBe("🎤 Voice message (0:07)");
  });

  it("an app card is quoted and pinned as the card names it, in the reader's language, not its English fallback and link", () => {
    const url = "https://raw.githubusercontent.com/ana/chess/HEAD/chess.ghostlyapp";
    const app: ChatMessage = { id: `peer_${"A".repeat(22)}`, text: `🧩 Opened Chess 1.2.0 in this chat (Ghostly app)\n${url}`, sender: "peer", timestamp: 1_700_000_002_000,
      card: { kind: "app", id: "a".repeat(22), ref: "r".repeat(52), digest: "d".repeat(43), sequence: 1, title: "Chess", version: "1.2.0", url, opened: true } };
    const zh = translateWith(locales.zh, "zh");
    // In a chat that draws it as a card (a 1:1 chat where Apps shows; elsewhere its text, appCardLineWhereShown.test.tsx).
    expect(messageSnippet(app, zh, true)).toBe("🧩 应用：Chess 1.2.0");
    expect(quoteFor({ id: "A".repeat(22), snippet: "", from: "peer", messageId: app.id }, replyIndex([app]), () => "Ana", zh, true).snippet).toBe("🧩 应用：Chess 1.2.0");
    renderApp(<PinnedBar pin={{ id: "A".repeat(22), messageId: app.id } as never} index={replyIndex([app])} appCards />, { language: "zh" });
    expect(screen.getByTestId("pinned-snippet")).toHaveTextContent(/^🧩 应用：Chess 1\.2\.0$/);
  });

  it("the pinned bar says it in the reader's language", () => {
    renderApp(<PinnedBar pin={{ id: WIRE, messageId: voice.id } as never} index={replyIndex([voice])} />, { language: "pt" });
    expect(screen.getByTestId("pinned-snippet")).toHaveTextContent("🎤 Mensagem de voz (0:07)");
  });
});

// covers: chat.pins
describe("a pin of an older message right after a reload, before the chat's history comes in", () => {
  /**
   * After a reload the chat shows its newest stored messages first (`STORED_MESSAGES`); the older ones come with the
   * engine's history. A pin of one of those older messages said "Not on this device" with its line disabled meanwhile,
   * where a reply's quote of the same message reads as loading (`quoteFor`). It waits the same way now; once the history
   * is in and the message really is not there, it still says so.
   */
  const RECENT = "R".repeat(22), OLD = "O".repeat(22);
  const recent: ChatMessage = { id: `peer_${RECENT}`, text: "see you at eight", sender: "peer", timestamp: 1_700_000_100_000 };
  const old: ChatMessage = { id: `peer_${OLD}`, text: "the door code is 4321", sender: "peer", timestamp: 1_700_000_000_000 };
  const pin = { id: OLD, messageId: old.id } as never;

  it("reads as loading, as a reply's quote of it does, not \"Not on this device\"", () => {
    renderApp(<PinnedBar pin={pin} index={replyIndex([recent], false, true)} />);
    const snippet = screen.getByTestId("pinned-snippet");
    expect(snippet).not.toHaveTextContent("Not on this device");
    expect(screen.getByTestId("pinned-open")).toHaveAttribute("data-state", "loading");
    expect(snippet).toHaveTextContent(/^…$/);
    expect(quoteFor({ id: OLD, snippet: "", from: "peer", messageId: old.id }, replyIndex([recent], false, true), () => "Alice").state).toBe("loading");
    // Nothing to jump to yet: the line waits, and opens the message once it is in.
    expect(screen.getByTestId("pinned-open")).toBeDisabled();
  });

  it("shows the message, and jumps to it, once the history is in", () => {
    const { rerender } = renderApp(<PinnedBar pin={pin} index={replyIndex([recent], false, true)} />);
    rerender(<PinnedBar pin={pin} index={replyIndex([old, recent])} />);
    expect(screen.getByTestId("pinned-snippet")).toHaveTextContent(/^the door code is 4321$/);
    expect(screen.getByTestId("pinned-open")).toBeEnabled();
  });

  it("still says \"Not on this device\" once the history is in and the message is not there", () => {
    renderApp(<PinnedBar pin={pin} index={replyIndex([recent])} />);
    expect(screen.getByTestId("pinned-snippet")).toHaveTextContent(/^Not on this device$/);
    expect(screen.getByTestId("pinned-open")).toBeDisabled();
  });

  it("says \"Not on this device\" at once for a pin the engine found no row for, older messages here or not", () => {
    renderApp(<PinnedBar pin={{ id: OLD } as never} index={replyIndex([recent], false, true)} />);
    expect(screen.getByTestId("pinned-snippet")).toHaveTextContent(/^Not on this device$/);
  });
});
