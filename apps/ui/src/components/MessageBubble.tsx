import { publicKeyLabel } from "../lib/publicKeyLabel";
import React, { memo, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { sameValue } from "../lib/sameValue";
import { clockTime } from "../lib/time";
import { useI18n } from "../contexts/I18nContext";
import { FileBubble } from "./FileBubble";
import { Menu, MenuItem } from "./Menu";
import { MessageBoundary } from "./MessageBoundary";
import { MessageDetailsPanel } from "./MessageDetailsPanel";
import { VoiceBubble } from "./voice/VoiceBubble";
import { VideoBubble } from "./video/VideoBubble";
import { isPlayableAudioType, isPlayableVideoType } from "@ghostly/core";
import { AudioBubble } from "./audio/AudioBubble";
import { InvoiceBubble } from "./InvoiceBubble";
import { findMoney } from "../lib/money";
import { PaymentBubble } from "./PaymentBubble";
import { RichText } from "./rich/RichText";
import { EntityCards } from "./chat/EntityCards";
import { MessageLinkCards } from "./LinkPreviewBubble";
import { CardTime, StatusCardView } from "./chat/StatusCard";
import { STATUS_TONE, cardLabel, showsCard } from "../lib/statusCards";
import { engine } from "@ghostly/browser/platform/engine";
import { playCue, useCueChat } from "../lib/cues";
import { downloadFile, downloadName, downloadState, type DownloadFormat } from "../lib/fileDownload";
import { canRetryFile } from "../lib/fileStatus";
import { useTransfer } from "../hooks/useServicesPlatform";
import type { ChatFile, ChatMessage } from "../lib/types";
import { callEventText } from "../lib/callLines";
import { formatCallLength } from "../lib/messageDetails";
import type { QuoteView } from "../lib/replies";
import { ReplyQuote } from "./chat/ReplyQuote";
import { ButtonPress, MessageButtons } from "./chat/MessageButtons";
import { isButtonPress, type ButtonsView } from "../lib/buttons";
import { SmileIcon } from "./composer/icons";
import { ReactAction, ReactionBar, ReactionChips } from "./chat/Reactions";
import { myReaction, reactionChips } from "../lib/reactions";
import { DeliveryStatus } from "./chat/DeliveryStatus";
import { forwardedLabel } from "../lib/forward";
import { PinIcon } from "./PinIcon";
import { copyText } from "../lib/shareLink";
import { SenderAvatar, type MessageAuthor } from "./chat/SenderAvatar";
import { useMemberText } from "../contexts/MemberColorsContext";

interface MessageBubbleProps {
  message: ChatMessage;
  peerAck?: number;
  /** Needed by payment bubbles, which can act on a request. */
  peerPubKey?: string;
  /** The contact's current name, for messages that do not carry one of their own. */
  peerNick?: string;
  /**
   * A 1:1 chat's name for the contact, as its header and the chat list show it ("" when they have none): the name over
   * their messages, plain. Left out in a group, where a member's own name goes over theirs with a "~".
   */
  contactName?: string;
  /** Forgets this message on this device. Left out where a chat cannot be edited. */
  onDelete?: () => void;
  /** The engine's link for the message's details; found from `peerPubKey` when left out (groups name theirs). */
  linkId?: string;
  /** Answers this message: its ⋮ says Reply, a pointer finds a reply button beside it, a finger swipes it right. */
  onReply?: () => void;
  /** The message this one answers, as the chat shows it (`quoteFor`). */
  quote?: QuoteView;
  /**
   * Reacts to this message (WISP 400 § Reactions), "" taking mine back: a pointer finds a React button beside it and
   * its ⋮ says React; a long press on a touch screen opens the quick bar. Left out where a message takes none.
   */
  onReact?: (emoji: string) => void;
  /** Who reacted, as the chat names them: `peer`, or a member's key. */
  reactionName?: (by: string) => string;
  /** Edits this message (WISP 400 § Edits): its ⋮ says Edit. Only a text of mine in a 1:1 chat. */
  onEdit?: () => void;
  /** Forwards this message (WISP 400 § Forwards): its ⋮ says Forward. Left out for what cannot be forwarded. */
  onForward?: () => void;
  /** Pins this message, or unpins it when it is the chat's pinned one (`pinned`), from its ⋮ (WISP 400 § Pinned message). */
  onPin?: () => void;
  pinned?: boolean;
  /** Starts choosing messages with this one chosen: its ⋮, and the bar a long press opens, say Select. */
  onSelect?: () => void;
  /**
   * The chat is choosing messages: the row is a checkbox (`onToggle`, left out for one that cannot be chosen), and its
   * menus, gestures and controls wait until the choice is over.
   */
  selection?: { selected: boolean; onToggle?: () => void };
  /** A chat search's words, marked in the text or the file's name: given only to the messages that hold them. */
  highlight?: string;
  /**
   * Who wrote a group member's message: their name takes their colour, and their picture sits beside the last bubble
   * of a run of theirs (`SenderAvatar`). Left out in a 1:1 chat and for my own messages.
   */
  author?: MessageAuthor;
  /** Opens what the chat knows of `author` (the group's members, theirs marked): a tap on their name or picture. */
  onOpenAuthor?: () => void;
  /**
   * A bot's buttons under the message (WISP 4xx · Message Buttons), as the chat's history has them (`buttonsViews`).
   * Left out, a message with buttons shows them, and none of them answers.
   */
  buttons?: ButtonsView;
  /**
   * This reply is a press of a button the question still has, on the question as the presser saw it (`compactPresses`):
   * it reads "↩ Yes". Otherwise it is drawn as any reply, with its quote.
   */
  compactPress?: boolean;
}

/** How long a finger holds a message before its quick bar (or, where it takes no reaction, its details) opens. */
export const LONG_PRESS_MS = 500;

/**
 * A press on a control inside a message is the control's, not a gesture's: except on one that is most of the message
 * and says so (`data-press-through`: a status card's line, which a tap opens).
 */
const onControl = (target: EventTarget) => {
  const control = (target as HTMLElement).closest("button, a, input, audio, video");
  return !!control && !control.hasAttribute("data-press-through");
};

/**
 * A long press on a touch screen (or a pen): the reactions' quick bar opens, with the details one tap under it; the
 * details at once where there is nothing to react with. A finger that moves on, or a press on a control inside the
 * message, is not one. The click a long press can end with is swallowed: it would open a card under the finger.
 */
function useLongPress(fire: () => void) {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const start = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  const clear = () => { clearTimeout(timer.current); timer.current = undefined; start.current = null; };
  useEffect(() => clear, []);
  return {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      fired.current = false;
      if (e.pointerType === "mouse" || e.button !== 0 || onControl(e.target)) return;
      start.current = { x: e.clientX, y: e.clientY };
      clearTimeout(timer.current);
      timer.current = setTimeout(() => { timer.current = undefined; fired.current = true; fire(); }, LONG_PRESS_MS);
    },
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => { if (start.current && Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > 10) clear(); },
    onPointerUp: clear,
    onPointerCancel: clear,
    // The browser's own long-press menu would sit on top of the details. Android asks here; iOS never does, so a
    // message's text is not selectable on a touch screen (index.css) and the bar has Copy.
    onContextMenu: (e: React.MouseEvent) => { if (fired.current || start.current) e.preventDefault(); },
    // Only on the control the press went through: the quick bar it opened takes its taps.
    onClickCapture: (e: React.MouseEvent) => {
      if (!fired.current || !(e.target as HTMLElement).closest("[data-press-through]")) return;
      fired.current = false; e.preventDefault(); e.stopPropagation();
    },
  };
}

/** How far a finger drags a message towards the reading direction's end before letting go answers it. */
export const SWIPE_REPLY_PX = 56;
/** The furthest a swiped message follows the finger. */
const SWIPE_MAX_PX = 80;

/**
 * Swipe to reply on a touch screen (or a pen), as in WhatsApp: the message follows the finger sideways and, let go
 * past `SWIPE_REPLY_PX`, answers. A drag that starts up or down is the list scrolling, and is left alone.
 */
function useSwipeReply(fire?: () => void) {
  const start = useRef<{ x: number; y: number; sign: 1 | -1 } | null>(null);
  const swiping = useRef(false);
  const [dx, setDx] = useState(0);
  const [sign, setSign] = useState<1 | -1>(1);
  const reset = () => { start.current = null; swiping.current = false; setDx(0); };
  if (!fire) return { dx: 0, offset: 0, handlers: {} };
  // Towards the end of the line: right, or left in a right-to-left language.
  const along = (e: ReactPointerEvent<HTMLElement>) => start.current!.sign * (e.clientX - start.current!.x);
  return {
    dx,
    offset: sign * dx,
    handlers: {
      onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
        if (e.pointerType === "mouse" || e.button !== 0 || onControl(e.target)) return;
        const rtl = getComputedStyle(e.currentTarget).direction === "rtl" ? -1 : 1;
        start.current = { x: e.clientX, y: e.clientY, sign: rtl }; swiping.current = false; setSign(rtl);
      },
      onPointerMove: (e: ReactPointerEvent<HTMLElement>) => {
        if (!start.current) return;
        const x = along(e), y = Math.abs(e.clientY - start.current.y);
        if (!swiping.current) {
          if (y > 12 && y > Math.abs(x)) { start.current = null; return; }
          if (x < 12 || x < y * 1.5) return;
          swiping.current = true;
          try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* a synthetic pointer has none */ }
        }
        setDx(Math.max(0, Math.min(SWIPE_MAX_PX, x)));
      },
      onPointerUp: (e: ReactPointerEvent<HTMLElement>) => {
        const done = swiping.current && start.current && along(e) >= SWIPE_REPLY_PX;
        reset();
        if (done) fire();
      },
      onPointerCancel: reset,
    },
  };
}

/** Both gestures on one row: each handler of each, in turn. */
function mergeHandlers<T extends Record<string, ((e: never) => void) | undefined>>(...all: Partial<T>[]): Partial<T> {
  const merged: Record<string, (e: never) => void> = {};
  for (const handlers of all) for (const [name, handler] of Object.entries(handlers)) {
    if (!handler) continue;
    const before = merged[name];
    merged[name] = before ? (e: never) => { before(e); (handler as (e: never) => void)(e); } : handler as (e: never) => void;
  }
  return merged as Partial<T>;
}

function ReplyGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="rtl:-scale-x-100">
      <path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </svg>
  );
}

function ForwardGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="rtl:-scale-x-100">
      <path d="m15 14 5-5-5-5" /><path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5 5.5 5.5 0 0 0 9.5 20H13" />
    </svg>
  );
}

function SelectGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" />
    </svg>
  );
}

/** "Forwarded" above a forwarded message (WISP 400 § Forwards), "Forwarded many times" past a few hops. Never from whom. */
function ForwardedMark({ hops }: { hops?: number }) {
  const { t } = useI18n();
  const label = forwardedLabel(hops);
  if (!label) return null;
  return (
    <div data-testid="message-forwarded" data-many={label === "chat.forward.many" || undefined}
      className="flex items-center gap-1 text-[12px] leading-[18px] italic text-text-primary/65 mb-[2px] px-[3px]">
      <ForwardGlyph size={13} />
      <span>{t(label)}</span>
    </div>
  );
}

function EditGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

/**
 * "edited" beside the time of an edited text (WISP 400 § Edits); the time of the edit on hover, or that the contact has
 * not been shown it yet. The earlier versions are in the message's details.
 */
function EditedMark({ edit, group }: { edit: NonNullable<ChatMessage["edit"]>; group?: boolean }) {
  const { t, language } = useI18n();
  const time = clockTime(edit.at, language);
  return (
    <span data-testid="message-edited" data-pending={edit.pending || undefined} className="text-[11px] leading-none text-text-primary/65 italic"
      title={edit.pending ? t(group ? "chat.message.editPendingGroup" : "chat.message.editPending") : t("chat.message.editedAt", { time })}>
      {t("chat.message.edited")}
    </span>
  );
}

/** Reply, beside a message, for a pointer: shown while the message is hovered or the button has the focus. */
function ReplyAction({ onReply }: { onReply: () => void }) {
  const { t } = useI18n();
  return (
    <button type="button" data-testid="message-reply-action" onClick={onReply} title={t("chat.message.reply")} aria-label={t("chat.message.reply")}
      className="self-center shrink-0 p-1 rounded-full text-text-muted hover:text-text-primary transition-all cursor-pointer max-md:hidden md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100">
      <ReplyGlyph />
    </button>
  );
}

const IMAGE_URL_RE =
  /^https:\/\/\S+\.(gif|png|jpe?g|webp)(\?\S*)?$/i;
const GIPHY_RE = /^https:\/\/media\d*\.giphy\.com\//i;
/** A Wayback Machine capture of a GIF: `/web/`, an optional timestamp (and `im_`/`id_`), then the archived http(s) URL. */
const WAYBACK_GIF_PATH_RE = /^\/web\/(?:\d{1,14}(?:im_|id_)?\/)?https?:\/\/[^/?#\s]+\/[^?#\s]*\.gif$/i;

/**
 * GeoCities GIFs from the Wayback Machine (the picker's "Retro" source): tiny pixel art. Only a capture of a GIF: the
 * URL must be exactly what it parses to (no `../` or `%2e%2e` resolved away, no query, no fragment, no credentials, no
 * port), so no other path of web.archive.org loads without "Show picture".
 */
function isWaybackGif(input: string): boolean {
  let url: URL;
  try { url = new URL(input); } catch { return false; }
  return url.protocol === "https:" && url.hostname === "web.archive.org" && !url.port && !url.username && !url.password
    && !url.search && !url.hash && url.href === input && WAYBACK_GIF_PATH_RE.test(url.pathname);
}
const DATA_IMAGE_SAFE_RE = /^data:image\/(png|jpe?g|gif|webp);/i;

type ContentType = "text" | "image";

function detectContentType(text: string): ContentType {
  const trimmed = text.trim();
  if (DATA_IMAGE_SAFE_RE.test(trimmed)) return "image";
  if (GIPHY_RE.test(trimmed)) return "image";
  if (IMAGE_URL_RE.test(trimmed)) return "image";
  return "text";
}

/** Pictures that show by themselves: inline data, and the GIF sources the picker uses. */
const autoLoads = (url: string) => DATA_IMAGE_SAFE_RE.test(url) || GIPHY_RE.test(url) || isWaybackGif(url);
const hostOf = (url: string) => { try { return new URL(url).host; } catch { return "picture"; } };

function isOnlyEmojis(text: string): boolean {
  const emojiPattern =
    /^(?:[\p{Emoji_Presentation}\p{Extended_Pictographic}]|\u200d|\uFE0F|\s)+$/u;
  return emojiPattern.test(text.trim()) && text.trim().length <= 12;
}

function TailSvg({ side }: { side: "left" | "right" }) {
  if (side === "right") {
    return (
      <span className="absolute top-0 -end-[8px] rtl:-scale-x-100 block w-[8px] h-[13px] overflow-hidden">
        <svg viewBox="0 0 8 13" width="8" height="13" className="block">
          <path d="M5 0H0V13C0 13 1.8 8.5 5 4.5C6.4 2.7 8 1 8 1L5 0Z" className="fill-sent-bg" />
        </svg>
      </span>
    );
  }
  return (
    <span className="absolute top-0 -start-[8px] rtl:-scale-x-100 block w-[8px] h-[13px] overflow-hidden">
      <svg viewBox="0 0 8 13" width="8" height="13" className="block">
        <path d="M3 0H8V13C8 13 6.2 8.5 3 4.5C1.6 2.7 0 1 0 1L3 0Z" className="fill-received-bg" />
      </svg>
    </span>
  );
}

function CallEventIcon({ type, hasVideo }: { type: string; hasVideo?: boolean }) {
  const isVideo = hasVideo;
  const isMissed = type === "call_missed" || type === "call_rejected" || type === "call_failed" || type === "call_unanswered";
  const isIncoming = type === "call_received" || type === "call_missed";
  
  return (
    <span className="inline-flex items-center justify-center me-2">
      {isVideo ? (
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={isMissed ? "text-danger" : "text-accent"}
        >
          <path d="M23 7l-7 5 7 5V7z" />
          <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
        </svg>
      ) : (
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={isMissed ? "text-danger" : "text-accent"}
        >
          <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
        </svg>
      )}
      {isIncoming && (
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`ms-[-4px] mt-[6px] ${isMissed ? "text-danger" : "text-accent"}`}
        >
          <line x1="17" y1="7" x2="7" y2="17" />
          <polyline points="17 17 7 17 7 7" />
        </svg>
      )}
      {!isIncoming && type !== "call_ended" && type !== "call_connected" && (
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="ms-[-4px] mt-[6px] text-accent"
        >
          <line x1="7" y1="17" x2="17" y2="7" />
          <polyline points="7 7 17 7 17 17" />
        </svg>
      )}
    </span>
  );
}

/** The chat's scrolling list of messages: a message's menus stay inside it (see `Menu`'s `within`). */
export const MESSAGE_LIST = "[data-message-list]";

const downloadIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
  </svg>
);

const retryIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" />
  </svg>
);

const cancelIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="9" /><path d="m15 9-6 6M9 9l6 6" />
  </svg>
);

/**
 * Saves a copy of the file a message carries (a voice message, a picture, a document), or a voice message
 * converted to MP3 here. Greyed with the reason while the file is still arriving, when it did not arrive, when
 * its bytes are gone from this device, or when this device could not convert it.
 */
function DownloadItem({ file, name, sender, format = "original", onDone }: { file: ChatFile; name: string; sender: "me" | "peer"; format?: DownloadFormat; onDone: () => void }) {
  const { t } = useI18n();
  const { platform, transfer, restoring } = useTransfer(file.id);
  const [problem, setProblem] = useState<"missing" | "unconverted" | null>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const state = downloadState(transfer, sender, restoring);
  const reason = problem === "missing" ? t("chat.message.downloadMissing")
    : problem === "unconverted" ? t("chat.message.downloadUnconverted")
    : state === "preparing" ? t("chat.message.downloadPreparing")
    : state === "restoring" ? t("common.loading")
    : state === "arriving" ? t("chat.message.downloadArriving")
    : state === "failed" ? t("chat.message.downloadFailed")
    : busy && format === "mp3" ? t("chat.message.downloadConverting")
    : undefined;
  const run = () => {
    if (!platform || busy) return;
    setBusy(true);
    // A conversion goes on when the menu closes: the file is still saved once it is made.
    void downloadFile(platform, file, name, format)
      .then((result) => { if (!mounted.current) return; if (result === "missing") setProblem("missing"); else onDone(); })
      .catch(() => { if (mounted.current) setProblem(format === "mp3" ? "unconverted" : "missing"); })
      .finally(() => { if (mounted.current) setBusy(false); });
  };
  return (
    <MenuItem testId={format === "mp3" ? "message-download-mp3" : "message-download"} onClick={run} disabled={!platform || !!reason} hint={reason} title={reason ?? name}
      data={{ "data-download-state": problem ?? (busy ? "busy" : state) }} icon={downloadIcon}>
      {t(format === "mp3" ? "chat.message.downloadMp3" : "chat.message.download")}
    </MenuItem>
  );
}

/**
 * Forward, in a message's ⋮: greyed with the reason while its file is still being prepared or arriving, or did not
 * arrive; the file goes from the bytes on this device, so they must all be here.
 */
function ForwardItem({ file, sender, onForward }: { file?: ChatFile; sender: "me" | "peer"; onForward: () => void }) {
  const { t } = useI18n();
  const { transfer, restoring } = useTransfer(file?.id);
  const state = file ? downloadState(transfer, sender, restoring) : "ready";
  const reason = state === "preparing" ? t("chat.message.downloadPreparing") : state === "restoring" ? t("common.loading")
    : state === "arriving" ? t("chat.message.downloadArriving")
    : state === "failed" ? t("chat.message.downloadFailed") : undefined;
  return (
    <MenuItem testId="message-forward" onClick={onForward} disabled={!!reason} hint={reason} icon={<ForwardGlyph />}>
      {t("chat.forward.forward")}
    </MenuItem>
  );
}

/**
 * What can be done to a message, behind its ⋮: answering it, sending it again or not at all, saving the file it carries,
 * its details, and forgetting it here.
 * The deletion is local, so the menu says so before it happens: nothing is sent, and the contact keeps their copy.
 * Both popovers are drawn over the page (the list scrolls and would cut them off) and kept inside the message list.
 */
function MessageMenu({ onDelete, onDetails, onReply, onEdit, onReact, onPin, pinned, onForward, onSelect, align, download, sender, onCancelSend, onRetry }: {
  onDelete?: () => void;
  onDetails: () => void;
  /** Answers the message (WISP 400 § Replies): the first row. */
  onReply?: () => void;
  /** Edits it (WISP 400 § Edits): after Reply. */
  onEdit?: () => void;
  /** Opens the reactions' quick bar (WISP 400 § Reactions): after Reply. */
  onReact?: () => void;
  /** Pins it, or unpins it (`pinned`) (WISP 400 § Pinned message): after React. */
  onPin?: () => void;
  pinned?: boolean;
  /** Forwards it (WISP 400 § Forwards): after React. */
  onForward?: () => void;
  /** Starts choosing messages, with this one: after Forward. */
  onSelect?: () => void;
  align: "left" | "right";
  /** Whose message it is: a file of mine is here to forward, one of theirs once it arrived. */
  sender?: "me" | "peer";
  /** A message carrying a file: the file, the name to save it under and who sent it (and, for a voice message, the MP3's name). */
  download?: { file: ChatFile; name: string; sender: "me" | "peer"; mp3Name?: string };
  /** Drops a message of mine that waits to be sent: in the place of Delete, which would say the contact keeps a copy. */
  onCancelSend?: () => void;
  /** Sends a message of mine that was not sent again. */
  onRetry?: () => void;
}) {
  const { t } = useI18n();
  const chat = useCueChat();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const side = align === "left" ? "end" : "start";

  return (
    <div ref={ref} className="relative self-center shrink-0">
      <button
        type="button"
        data-testid="message-options"
        title={t("chat.message.options")}
        aria-label={t("chat.message.options")}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        // Faint but always reachable by touch; on a pointer it waits for the message to be hovered.
        className={`p-1 rounded-full transition-all cursor-pointer hover:text-text-primary md:group-hover:opacity-100 md:focus-visible:opacity-100 ${
          open || confirm ? "text-text-primary opacity-100" : "text-text-muted max-md:opacity-40 md:opacity-0"
        }`}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="12" cy="5" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="12" cy="19" r="2" />
        </svg>
      </button>
      <Menu open={open} onClose={() => setOpen(false)} anchorRef={ref} testId="message-menu" align={side} prefer="up" portal within={MESSAGE_LIST} focusFirst label={t("chat.message.options")}>
        {onReply && <MenuItem testId="message-reply" onClick={() => { setOpen(false); onReply(); }} icon={<ReplyGlyph />}>
          {t("chat.message.reply")}
        </MenuItem>}
        {onEdit && <MenuItem testId="message-edit" onClick={() => { setOpen(false); onEdit(); }} icon={<EditGlyph />}>
          {t("chat.message.edit")}
        </MenuItem>}
        {onReact && <MenuItem testId="message-react" onClick={() => { setOpen(false); onReact(); }} icon={<SmileIcon size={16} />}>
          {t("chat.reactions.react")}
        </MenuItem>}
        {onPin && <MenuItem testId="message-pin" onClick={() => { setOpen(false); onPin(); }} icon={<PinIcon active={pinned} size={16} />}>
          {pinned ? t("chat.pinned.unpin") : t("chat.pinned.pin")}
        </MenuItem>}
        {onForward && <ForwardItem file={download?.file} sender={sender ?? "me"} onForward={() => { setOpen(false); onForward(); }} />}
        {onSelect && <MenuItem testId="message-select-start" onClick={() => { setOpen(false); onSelect(); }} icon={<SelectGlyph />}>
          {t("chat.forward.select")}
        </MenuItem>}
        {onRetry && <MenuItem testId="message-retry" onClick={() => { setOpen(false); onRetry(); }} icon={retryIcon}>
          {t("chat.message.retry")}
        </MenuItem>}
        {download && <DownloadItem file={download.file} name={download.name} sender={download.sender} onDone={() => setOpen(false)} />}
        {download?.mp3Name && <DownloadItem file={download.file} name={download.mp3Name} sender={download.sender} format="mp3" onDone={() => setOpen(false)} />}
        <MenuItem testId="message-details" onClick={() => { setOpen(false); onDetails(); }}
          icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 16v-4M12 8h.01" /></svg>}>
          {t("chat.message.details")}
        </MenuItem>
        {onCancelSend && <MenuItem testId="message-cancel-sending" danger onClick={() => { setOpen(false); onCancelSend(); }} icon={cancelIcon}>
          {t("chat.message.cancelSending")}
        </MenuItem>}
        {onDelete && !onCancelSend && <MenuItem testId="message-delete" danger onClick={() => { setOpen(false); setConfirm(true); }}
          icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18" /><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" /><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" /></svg>}>
          {t("chat.deleteMessage")}
        </MenuItem>}
      </Menu>
      {onDelete && (
        <Menu open={confirm} onClose={() => setConfirm(false)} anchorRef={ref} testId="message-delete-menu" align={side} prefer="up" portal within={MESSAGE_LIST} label={t("chat.deleteMessage")}>
          <div className="px-3 py-2 md:w-[210px]">
            <p className="m-0 mb-2 whitespace-normal text-[11px] leading-snug text-text-muted">{t("chat.deleteMessageHint")}</p>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirm(false)}
                className="px-2 py-0.5 rounded border border-border bg-surface-hover text-text-muted text-xs font-bold hover:text-text-secondary transition-colors cursor-pointer max-md:min-h-10 max-md:px-4"
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                data-testid="message-delete-confirm"
                onClick={() => {
                  setConfirm(false);
                  playCue("deleted", { chat });
                  onDelete();
                }}
                className="px-2 py-0.5 rounded border border-danger/30 bg-danger/20 text-danger text-xs font-bold hover:bg-danger/30 transition-colors cursor-pointer max-md:min-h-10 max-md:px-4"
              >
                {t("common.delete")}
              </button>
            </div>
          </div>
        </Menu>
      )}
    </div>
  );
}

/** What a bubble draws with: `reactionName`'s answers for the reactions it has, so a change of names redraws it. */
type BubbleViewProps = MessageBubbleProps & { names: string };

/**
 * A message's bubble, behind its own error boundary: one message that fails to draw never takes the chat down.
 *
 * A chat draws every one of its messages again on each change of its page (the engine's state, a delivery tick, a
 * name), and a long chat has thousands. So a bubble is drawn again only when what it shows changes: its message and
 * its quote by content (they are read again from storage, as new objects with the same data), the other values as
 * they are, and each callback only by whether it is there. The callbacks it gets call the latest ones given.
 */
export function MessageBubble(props: MessageBubbleProps) {
  const latest = useRef(props);
  // Set while drawing: `reactionName` is called while the bubble draws, with this very draw's props.
  latest.current = props;
  const stable = useMemo(() => ({
    onDelete: () => latest.current.onDelete?.(),
    onReply: () => latest.current.onReply?.(),
    onEdit: () => latest.current.onEdit?.(),
    onReact: (emoji: string) => latest.current.onReact?.(emoji),
    onForward: () => latest.current.onForward?.(),
    onPin: () => latest.current.onPin?.(),
    onSelect: () => latest.current.onSelect?.(),
    onOpenAuthor: () => latest.current.onOpenAuthor?.(),
    onToggle: () => latest.current.selection?.onToggle?.(),
    reactionName: (by: string) => latest.current.reactionName?.(by) ?? by.slice(0, 8),
  }), []);
  const { message, peerAck = 0, selection } = props;
  // Only a message of mine without its own delivery state reads the contact's acknowledgement: one number per bubble.
  const acked = message.sender === "me" && !message.delivery && peerAck >= message.timestamp;
  const names = message.reactions ? Object.keys(message.reactions).map(stable.reactionName).join("\n") : "";
  return (
    <SameBubble
      message={message} peerAck={acked ? message.timestamp : message.timestamp - 1}
      peerPubKey={props.peerPubKey} peerNick={props.peerNick} contactName={props.contactName} linkId={props.linkId} quote={props.quote} names={names}
      onDelete={props.onDelete && stable.onDelete} onReply={props.onReply && stable.onReply} onEdit={props.onEdit && stable.onEdit}
      onReact={props.onReact && stable.onReact} onForward={props.onForward && stable.onForward} onSelect={props.onSelect && stable.onSelect}
      onPin={props.onPin && stable.onPin} pinned={props.pinned} author={props.author} onOpenAuthor={props.onOpenAuthor && stable.onOpenAuthor}
      reactionName={stable.reactionName} highlight={props.highlight} buttons={props.buttons} compactPress={props.compactPress}
      selection={selection && { selected: selection.selected, ...(selection.onToggle && { onToggle: stable.onToggle }) }}
    />
  );
}

const CALLBACKS = ["onDelete", "onReply", "onEdit", "onReact", "onForward", "onSelect", "onPin", "onOpenAuthor"] as const;

/** The same bubble to draw: see `MessageBubble`. */
function sameBubble(a: BubbleViewProps, b: BubbleViewProps): boolean {
  return a.peerAck === b.peerAck && a.peerPubKey === b.peerPubKey && a.peerNick === b.peerNick && a.contactName === b.contactName && a.linkId === b.linkId && a.names === b.names && a.highlight === b.highlight && !a.pinned === !b.pinned && !a.compactPress === !b.compactPress
    && CALLBACKS.every(name => !a[name] === !b[name])
    && !a.selection === !b.selection && a.selection?.selected === b.selection?.selected && !a.selection?.onToggle === !b.selection?.onToggle
    && sameValue(a.quote, b.quote) && sameValue(a.author, b.author) && sameValue(a.buttons, b.buttons) && sameValue(a.message, b.message);
}

const SameBubble = memo(function SameBubble(props: BubbleViewProps) {
  const { message } = props;
  return (
    <MessageBoundary key={message.id} text={message.text} fromMe={message.sender === "me"}>
      <MessageBubbleView {...props} />
    </MessageBoundary>
  );
}, sameBubble);

function MessageBubbleView({ message, peerAck = 0, peerPubKey = "", peerNick = "", contactName, onDelete: deleteIt, linkId, onReply: replyIt, quote, onEdit: editIt, onReact: reactIt, reactionName, onForward: forwardIt, onSelect: selectIt, onPin: pinIt, pinned, selection, names, highlight, author, onOpenAuthor, buttons, compactPress }: BubbleViewProps) {
  // While the chat is choosing messages, a row is a checkbox: nothing else on it answers.
  const choosing = !!selection;
  const onPin = choosing ? undefined : pinIt;
  const onDelete = choosing ? undefined : deleteIt, onReply = choosing ? undefined : replyIt, onEdit = choosing ? undefined : editIt;
  const onReact = choosing ? undefined : reactIt, onForward = choosing ? undefined : forwardIt, onSelect = choosing ? undefined : selectIt;
  const { t, language, dir } = useI18n();
  const memberText = useMemberText();
  const chat = useCueChat();
  // Only what arrives while you watch moves; history is just there.
  const [enter] = useState(() =>
    Date.now() - message.timestamp < 5000
      ? message.sender === "me"
        ? "animate-bubble-in-right"
        : "animate-bubble-in-left"
      : "",
  );
  // A button press (WISP 4xx · Message Buttons) reads "↩ Yes": its label is never a sum, a picture or a quote.
  const pressed = !!compactPress && isButtonPress(message);
  const money = useMemo(() => (message.paymentId || message.file || pressed || showsCard(message.card) ? null : findMoney(message.text)), [message.paymentId, message.file, pressed, message.card, message.text]);
  const [details, setDetails] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const openDetails = () => setDetails(true);
  // What Copy under a long press copies: a message's own words, not a file's name, a payment's or a card's.
  const copyable = message.file || message.paymentId || pressed || showsCard(message.card) ? "" : message.text.trim();
  // The reactions' quick bar: from the React button or the ⋮ (`button`), or a long press (`press`, with Details under it).
  const [bar, setBar] = useState<"button" | "press" | null>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const reactRef = useRef<HTMLSpanElement>(null);
  const press = useLongPress(onReact ? () => setBar("press") : onSelect ?? openDetails);
  // `names`: the names `reactionName` gives now, which can change while the function stays the same.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `names` is what `reactionName` answers
  const chips = useMemo(() => reactionChips(message.reactions, by => reactionName?.(by) ?? by.slice(0, 8), t("chat.reply.you")), [message.reactions, reactionName, t, names]);
  const swipe = useSwipeReply(onReply);
  const [imgError, setImgError] = useState(false);
  const [revealed, setRevealed] = useState(false);
  /** The picture link whose picture has loaded: until it has, its box keeps a placeholder's height. */
  const [pictureLoaded, setPictureLoaded] = useState<string | null>(null);
  const isMe = message.sender === "me";
  const isSystem = message.sender === "system";
  const isAcked = isMe && (message.delivery ? message.delivery === "delivered" : peerAck >= message.timestamp);
  const { platform, transfer } = useTransfer(isMe ? message.file?.id : undefined);
  // A file of mine whose bytes did not go has the red mark, not ticks beside its "Not sent". While they move, the
  // message keeps its own mark: the bytes' progress is the file's to show (held files travel by hold/1, not files/3).
  const fileFailed = !!message.file && canRetryFile(message.file, transfer, platform);
  const shown = fileFailed ? "failed" as const : message.delivery;
  /** A message that was not sent, sent again: its red mark, or its ⋮. */
  const retry = () => {
    if (fileFailed) { void platform!.retryFile!(message.file!.id).catch(() => {}); return; }
    const link = engine.linkByPeer(peerPubKey);
    if (link) void engine.call("retryMessage", { linkId: link.id, messageId: message.id }).catch(() => {});
  };
  /** What waits to be sent, dropped: it never left, so the chat's own delete (the list forgets it too), with no confirmation. */
  const cancelSending = () => {
    playCue("deleted", { chat });
    if (onDelete) { onDelete(); return; }
    const link = engine.linkByPeer(peerPubKey);
    if (link) void engine.call("deleteMessage", { linkId: link.id, messageId: message.id }).catch(() => {});
  };
  const sending = isMe && message.delivery === "waiting" ? { onCancelSend: cancelSending } : isMe && shown === "failed" ? { onRetry: retry } : {};
  const time = clockTime(message.timestamp, language);
  const contentType = imgError || message.file || message.paymentId || pressed ? "text" : detectContentType(message.text);
  const download = message.file && !isSystem
    ? {
      file: message.file, name: downloadName(message.file, message.timestamp), sender: isMe ? "me" as const : "peer" as const,
      ...(message.file.voice ? { mp3Name: downloadName(message.file, message.timestamp, "mp3") } : {}),
    }
    : undefined;
  const detailsPanel = details && (
    <MessageDetailsPanel message={message} linkId={linkId ?? (peerPubKey ? engine.linkByPeer(peerPubKey)?.id : undefined)}
      picture={contentType === "image"} onClose={() => setDetails(false)} returnFocus={rowRef.current} />
  );
  const rowProps = choosing ? {
    ref: rowRef, "data-message-id": message.id, "data-selected": selection.selected || undefined,
    // A click anywhere on the row (a player's button included) chooses it or not; nothing inside it runs.
    onClickCapture: (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); selection.onToggle?.(); },
  } : {
    ref: rowRef, onDoubleClick: openDetails, ...mergeHandlers(press, swipe.handlers), "data-details-open": details || undefined, "data-message-id": message.id,
    // The second click of a double click would select a word of the message under the details.
    onMouseDown: (e: React.MouseEvent) => { if (e.detail > 1) e.preventDefault(); },
  };
  const selectBox = selection && (
    <span role="checkbox" aria-checked={selection.selected} aria-disabled={!selection.onToggle || undefined} aria-label={t("chat.forward.select")}
      data-testid="message-select" tabIndex={selection.onToggle ? 0 : -1}
      onKeyDown={(e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); selection.onToggle?.(); } }}
      className={`self-center shrink-0 w-5 h-5 me-2 rounded-full border-2 flex items-center justify-center ${selection.onToggle ? "cursor-pointer" : "invisible"} ${selection.selected ? "bg-accent border-accent text-on-accent" : "border-text-muted"}`}>
      {selection.selected && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7" /></svg>}
    </span>
  );

  if (isSystem && message.systemEvent?.type === "join") {
    const joiner = message.systemEvent.pubKey ?? "";
    // Both sides announce themselves (useChat.ts), so a 1:1 chat has two lines: mine says so, the contact's names
    // them as the chat does. Only a contact with no name yet is shown by a short key.
    const mine = !!joiner && !!peerPubKey && joiner !== peerPubKey;
    const name = mine ? "" : peerNick || message.nick || "";
    const pubKeyShort = joiner ? publicKeyLabel(joiner) : "";

    return (
      <div {...rowProps} data-message-row data-sender="system" className={`group flex items-center justify-center gap-1 mb-3.5 message-row-x ${enter}`}>
        <div data-testid="join-line" title={joiner || undefined} className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs bg-blue-500/10 text-link ${details ? "outline-2 outline-accent outline-offset-2" : ""}`}>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
            <polyline points="10 17 15 12 10 7" />
            <line x1="15" y1="12" x2="3" y2="12" />
          </svg>
          {mine ? <span>{t("chat.youJoined")}</span> : (
            <span>
              {name ? <span className="font-semibold" dir="auto">{name}</span> : <span className="font-mono font-semibold">{pubKeyShort}</span>}
              {" "}{t("chat.joined")}
            </span>
          )}
          <span className="text-text-muted text-[10px]">{time}</span>
        </div>
        {!choosing && <MessageMenu onDelete={onDelete} onDetails={openDetails} align="right" />}
        {detailsPanel}
      </div>
    );
  }

  if (isSystem && message.callEvent) {
    const { type, hasVideo, duration } = message.callEvent;
    const isMissed = type === "call_missed" || type === "call_rejected" || type === "call_failed" || type === "call_unanswered";
    
    return (
      <div {...rowProps} data-message-row data-sender="system" className={`group flex items-center justify-center gap-1 mb-3.5 message-row-x ${enter}`}>
        <div
          className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs ${
            isMissed
              ? "bg-danger/10 text-danger"
              : "bg-surface-alt/80 text-text-secondary"
          } ${details ? "outline-2 outline-accent outline-offset-2" : ""}`}
        >
          <CallEventIcon type={type} hasVideo={hasVideo} />
          <span>{callEventText(t, type, hasVideo) ?? message.text}</span>
          {duration !== undefined && duration > 0 && (
            <span className="text-text-muted">({formatCallLength(duration, t)})</span>
          )}
          <span className="text-text-muted text-[10px]">{time}</span>
        </div>
        {!choosing && <MessageMenu onDelete={onDelete} onDetails={openDetails} align="right" />}
        {detailsPanel}
      </div>
    );
  }

  // A 1:1 chat names the contact over their messages as its header does, plain: it said "~Botty" under a header of
  // "Botty". In a group the "~" marks the name a member gave themselves, which no contact name of yours replaces.
  const own = contactName ?? (message.nick || peerNick);
  const nick = own && !isMe && (!author || author.first) ? `${contactName === undefined ? "~" : ""}${own}` : "";
  const nickEl = nick ? (
    // A group member's name takes their colour (lib/memberColors.ts), and a tap on it opens who they are.
    <div data-testid="message-nick" data-key={author?.key} className={`${author ? memberText(author.key) : "text-accent-hover"} text-[12.8px] font-medium mb-[2px] leading-[22px]`}>
      {author && onOpenAuthor && !choosing
        ? <button type="button" data-testid="message-nick-open" onClick={onOpenAuthor} onDoubleClick={e => e.stopPropagation()} aria-haspopup="dialog" className="max-w-full cursor-pointer text-start hover:underline">{nick}</button>
        : nick}
    </div>
  ) : null;
  const menu = !choosing && (
    <MessageMenu onDelete={onDelete} onDetails={openDetails} onReply={onReply} onEdit={isMe ? onEdit : undefined} onReact={onReact && (() => setBar("button"))} onPin={onPin} pinned={pinned}
      onForward={onForward} onSelect={onSelect} align={isMe ? "left" : "right"} download={download} sender={isMe ? "me" : "peer"} {...(isMe ? sending : {})} />
  );

  if (showsCard(message.card)) {
    // A bot's task or routine (WISP 4xx · Status Cards): not a bubble but a card of its own, standing for the text
    // (its fallback). Updates are its normal life, so no "edited": when it last changed, in the card.
    const card = message.card;
    const time = <CardTime sent={message.timestamp} changed={message.edit?.at} />;
    const marks = isMe ? <DeliveryStatus delivery={shown} acked={isAcked} onRetry={retry} /> : undefined;
    const edge = card.kind === "task" ? STATUS_TONE[card.status].bar
      : card.state === "paused" ? "bg-text-muted" : card.lastRun?.result === "failed" ? "bg-danger" : undefined;
    return (
      <div
        {...rowProps}
        data-message-row data-card-row
        data-sender={isMe ? "me" : "peer"} data-member={isMe ? undefined : author?.key}
        className={`group flex items-start gap-1 ${isMe ? "justify-end" : "justify-start"} mb-3.5 message-row-x ${onReply ? "touch-pan-y" : ""} ${swipe.dx > 0 ? "overflow-x-clip" : ""} ${choosing ? `cursor-pointer ${selection.selected ? "bg-accent/10" : ""}` : ""} ${enter}`}
      >
        {selectBox}
        {choosing && isMe && <span className="flex-1" aria-hidden="true" />}
        {swipe.dx > 0 && (
          <span data-testid="swipe-reply-hint" aria-hidden="true" className="self-center shrink-0 text-text-muted" style={{ opacity: Math.min(1, swipe.dx / SWIPE_REPLY_PX) }}>
            <ReplyGlyph />
          </span>
        )}
        {isMe && onReact && <ReactAction anchorRef={reactRef} open={bar === "button"} onOpen={() => setBar(bar ? null : "button")} />}
        {isMe && onReply && <ReplyAction onReply={onReply} />}
        {isMe && menu}
        {!isMe && author && <SenderAvatar author={author} onOpen={choosing ? undefined : onOpenAuthor} />}
        {/* The name over the card, the card, its reactions under it: as wide as a wide bubble. */}
        <div className={`flex flex-col min-w-0 w-[min(420px,85%)] ${isMe ? "items-end" : "items-start"}`}>
          {/* A group member's name, over the first of a run of theirs; a 1:1 chat has one sender, and no name. */}
          {author && nickEl && <div className="max-w-full px-1">{nickEl}</div>}
          <ForwardedMark hops={message.forwarded} />
          <div
            ref={bubbleRef}
            data-message-card
            role="group"
            aria-label={cardLabel(t, card)}
            className={`status-card-surface w-full text-text-primary ${details ? "outline-2 outline-accent outline-offset-2" : ""}`}
            style={swipe.dx > 0 ? { transform: `translateX(${swipe.offset}px)` } : undefined}
          >
            {/* A thin mark of its status at its start, inside the edge: a task's status colour; a routine only when its
                last run failed (red) or it is paused (muted), as ten routines going well need no colour each. */}
            {edge && <span aria-hidden="true" data-testid="status-card-edge" className={`absolute inset-y-2 start-1 w-[3px] rounded-full opacity-80 ${edge}`} />}
            {quote && <div className="px-2 pt-2"><ReplyQuote quote={quote} /></div>}
            <StatusCardView card={card} time={time} marks={marks} end={message.edit?.at ?? message.timestamp} />
          </div>
          <ReactionChips chips={chips} onReact={onReact} align={isMe ? "end" : "start"} />
        </div>
        {!isMe && menu}
        {!isMe && onReply && <ReplyAction onReply={onReply} />}
        {!isMe && onReact && <ReactAction anchorRef={reactRef} open={bar === "button"} onOpen={() => setBar(bar ? null : "button")} />}
        {onReact && <ReactionBar open={!!bar} onClose={() => setBar(null)} anchorRef={bubbleRef} current={myReaction(message.reactions)} onReact={onReact}
          align={isMe ? "end" : "start"} onDetails={bar === "press" ? openDetails : undefined} onSelect={bar === "press" ? onSelect : undefined} />}
        {detailsPanel}
      </div>
    );
  }

  const bigEmoji = contentType === "text" && !pressed && isOnlyEmojis(message.text);
  // A message with buttons and no view from the chat (a chat that takes no replies): shown, none of them answers.
  const buttonsView = message.card?.kind === "buttons" ? buttons ?? { card: message.card, open: false } : undefined;

  const timestampEl = (
    <span dir={dir} className="msg-meta inline-flex items-center gap-[3px] float-end relative top-[4px] ms-[8px] select-none">
      {/* A question's buttons marked or closed by its bot is its normal life, not an edit to point out; a new text is. */}
      {message.edit && (!buttonsView || !!message.edit.history?.length) && <EditedMark edit={message.edit} group={linkId?.startsWith("group:")} />}
      <span className="text-[11px] leading-none text-text-primary/65">
        {time}
      </span>
      {isMe && <DeliveryStatus delivery={shown} acked={isAcked} onRetry={retry} />}
    </span>
  );

  return (
    <div
      {...rowProps}
      data-message-row
      data-sender={isMe ? "me" : "peer"} data-member={isMe ? undefined : author?.key}
      className={`group flex items-start gap-1 ${isMe ? "justify-end" : "justify-start"} mb-3.5 message-row-x ${onReply ? "touch-pan-y" : ""} ${swipe.dx > 0 ? "overflow-x-clip" : ""} ${choosing ? `cursor-pointer ${selection.selected ? "bg-accent/10" : ""}` : ""} ${enter}`}
    >
      {selectBox}
      {/* The checkbox at the start, the message at its side of the line. */}
      {choosing && isMe && <span className="flex-1" aria-hidden="true" />}
      {swipe.dx > 0 && (
        // What letting go does, uncovered as the message moves.
        <span data-testid="swipe-reply-hint" aria-hidden="true" className="self-center shrink-0 text-text-muted" style={{ opacity: Math.min(1, swipe.dx / SWIPE_REPLY_PX) }}>
          <ReplyGlyph />
        </span>
      )}
      {isMe && onReact && <ReactAction anchorRef={reactRef} open={bar === "button"} onOpen={() => setBar(bar ? null : "button")} />}
      {isMe && onReply && <ReplyAction onReply={onReply} />}
      {isMe && !choosing && <MessageMenu onDelete={onDelete} onDetails={openDetails} onReply={onReply} onEdit={onEdit} onReact={onReact && (() => setBar("button"))} onPin={onPin} pinned={pinned} onForward={onForward} onSelect={onSelect} align="left" download={download} sender="me" {...sending} />}
      {/* A group member's picture at the start of the line (the reading direction's), or its empty place. */}
      {!isMe && author && <SenderAvatar author={author} onOpen={choosing ? undefined : onOpenAuthor} />}
      {/* The bubble, and its reactions under it. */}
      <div className={`flex flex-col min-w-0 max-w-[85%] ${isMe ? "items-end" : "items-start"}`}>
      {/* Bubbles take the theme's colours; what is inside reads on either one (see e2e/web/bubble-contrast.spec.ts). */}
      <div
        ref={bubbleRef}
        data-message-bubble
        className={`relative max-w-full min-w-[80px] ${
          isMe
            ? "rounded-ss-[7.5px] rounded-es-[7.5px] rounded-ee-[7.5px]"
            : "rounded-se-[7.5px] rounded-es-[7.5px] rounded-ee-[7.5px]"
        } ${
          contentType === "image"
            ? "p-[3px] pb-[3px]"
            : "px-[9px] pt-[6px] pb-[8px]"
        } ${
          isMe
            ? "bg-sent-bg text-text-primary"
            : "bg-received-bg text-text-primary"
        } ${details ? "outline-2 outline-accent outline-offset-2" : ""}`}
        style={{
          boxShadow: "0 1px 0.5px rgba(11,20,26,0.13)",
          ...(swipe.dx > 0 && { transform: `translateX(${swipe.offset}px)` }),
        }}
      >
        <TailSvg side={isMe ? "right" : "left"} />
        {/* In a group, the name is over the first message of a run only. */}
        {nickEl}

        <ForwardedMark hops={message.forwarded} />
        {quote && !pressed && <ReplyQuote quote={quote} />}

        {pressed ? (
          <div className="clearfix">
            <ButtonPress label={message.text} targetId={quote?.targetId} />
            {timestampEl}
          </div>
        ) : message.paymentId ? (
          <div className="clearfix">
            <PaymentBubble paymentId={message.paymentId} peerPubKey={peerPubKey} fallbackText={message.text} />
            {timestampEl}
          </div>
        ) : message.file?.voice ? (
          <div className="clearfix">
            <VoiceBubble file={{ ...message.file, voice: message.file.voice }} sender={isMe ? "me" : "peer"} peerName={message.nick || peerNick || undefined} />
            {timestampEl}
          </div>
        ) : message.file && isPlayableVideoType(message.file.mime) ? (
          <div className="clearfix">
            <VideoBubble file={message.file} sender={isMe ? "me" : "peer"} peerName={message.nick || peerNick || undefined} />
            {timestampEl}
          </div>
        ) : message.file && isPlayableAudioType(message.file.mime) ? (
          <div className="clearfix">
            <AudioBubble file={message.file} sender={isMe ? "me" : "peer"} peerName={message.nick || peerNick || undefined} highlight={highlight} />
            {timestampEl}
          </div>
        ) : message.file ? (
          <div className="clearfix">
            <FileBubble file={message.file} peerName={message.nick || peerNick || undefined} highlight={highlight} />
            {timestampEl}
          </div>
        ) : money ? (
          <div className="clearfix">
            <InvoiceBubble money={money} mine={isMe} peerPubKey={peerPubKey} />
            {timestampEl}
          </div>
        ) : contentType === "image" && !isMe && !revealed && !autoLoads(message.text.trim()) ? (
          // Loading a picture tells its server this device's address: from anywhere but the GIF sources,
          // a contact's picture waits for a click.
          <div className="clearfix">
            <button type="button" data-testid="image-reveal" onClick={() => setRevealed(true)}
              className="text-sm text-link underline decoration-dotted cursor-pointer break-all text-start">
              {t("chat.showPicture", { host: hostOf(message.text.trim()) })}
            </button>
            {timestampEl}
          </div>
        ) : contentType === "image" ? (
          <div className="relative">
            {/* A link says nothing of its picture's size: a placeholder 120 px high (as high as most GIFs and photos are
                at least, shown here) until it loads, so it grows less when it does. */}
            <img
              src={message.text.trim()}
              alt=""
              data-testid="picture-link"
              className={`rounded-[4px] max-w-[min(330px,72vw)] min-w-[120px] max-h-[330px] object-contain block ${pictureLoaded === message.text.trim() ? "" : "min-h-[120px] bg-black/10"}`}
              style={isWaybackGif(message.text.trim()) ? { imageRendering: "pixelated" } : undefined}
              loading="lazy"
              onLoad={() => setPictureLoaded(message.text.trim())}
              onError={() => setImgError(true)}
            />
            <span data-picture-time className="absolute bottom-[4px] end-[6px] inline-flex items-center gap-[3px] bg-[rgba(11,20,26,0.55)] rounded-full px-[6px] py-[3px]">
              <span className="text-[11px] leading-none text-[hsla(0,0%,100%,0.9)]">
                {time}
              </span>
              {isMe && <DeliveryStatus delivery={shown} acked={isAcked} onRetry={retry} onPicture />}
            </span>
          </div>
        ) : bigEmoji ? (
          <div className="clearfix">
            <span className="text-[42px] leading-[50px] block text-center py-[2px]">
              {message.text}
            </span>
            {timestampEl}
          </div>
        ) : (
          // What was written reads in its own direction (an English message in the Arabic app left to right, an Arabic
          // one in the English app right to left), with the time at its end; the cards and the time keep the app's.
          <div className="clearfix" dir="auto" data-testid="message-body">
            <RichText testId="message-text" text={message.text} sentAt={message.timestamp} mentions={message.mentions} highlight={highlight} className="text-[14.2px] leading-[19px] wrap-break-word whitespace-pre-wrap" />
            {/* No box of its own: with no card the time still floats beside the last line of text. */}
            <div dir={dir} className="contents">
              <EntityCards text={message.text} mine={isMe} from={message.nick || peerNick || undefined} peerPubKey={peerPubKey} />
              <MessageLinkCards text={message.text} preview={message.preview} />
            </div>
            {timestampEl}
          </div>
        )}
      </div>
      {buttonsView && <MessageButtons view={buttonsView} messageId={message.id} linkId={linkId ?? (peerPubKey ? engine.linkByPeer(peerPubKey)?.id : undefined)} />}
      <ReactionChips chips={chips} onReact={onReact} align={isMe ? "end" : "start"} />
      </div>
      {!isMe && !choosing && <MessageMenu onDelete={onDelete} onDetails={openDetails} onReply={onReply} onReact={onReact && (() => setBar("button"))} onPin={onPin} pinned={pinned} onForward={onForward} onSelect={onSelect} align="right" download={download} sender="peer" />}
      {!isMe && onReply && <ReplyAction onReply={onReply} />}
      {!isMe && onReact && <ReactAction anchorRef={reactRef} open={bar === "button"} onOpen={() => setBar(bar ? null : "button")} />}
      {onReact && <ReactionBar open={!!bar} onClose={() => setBar(null)} anchorRef={bubbleRef} current={myReaction(message.reactions)} onReact={onReact}
        align={isMe ? "end" : "start"} onDetails={bar === "press" ? openDetails : undefined} onSelect={bar === "press" ? onSelect : undefined}
        onCopy={bar === "press" && copyable ? () => void copyText(copyable).catch(() => {}) : undefined} />}
      {detailsPanel}
    </div>
  );
}
