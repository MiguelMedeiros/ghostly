import { useOutsideDismiss } from "../hooks/useDismiss";
import { publicKeyLabel } from "../lib/publicKeyLabel";
import React, { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useI18n } from "../contexts/I18nContext";
import { FileBubble } from "./FileBubble";
import { Menu, MenuItem } from "./Menu";
import { MessageDetailsPanel } from "./MessageDetailsPanel";
import { VoiceBubble } from "./voice/VoiceBubble";
import { InvoiceBubble } from "./InvoiceBubble";
import { findMoney } from "../lib/money";
import { PaymentBubble } from "./PaymentBubble";
import { engine } from "@ghostly/browser/platform/engine";
import type { ChatMessage } from "../lib/types";

interface MessageBubbleProps {
  message: ChatMessage;
  peerAck?: number;
  /** Needed by payment bubbles, which can act on a request. */
  peerPubKey?: string;
  /** The contact's current name, for messages that do not carry one of their own. */
  peerNick?: string;
  /** Forgets this message on this device. Left out where a chat cannot be edited. */
  onDelete?: () => void;
  /** The engine's link for the message's details; found from `peerPubKey` when left out (groups name theirs). */
  linkId?: string;
}

/** How long a finger holds a message before its details open. */
export const LONG_PRESS_MS = 500;

/**
 * A long press on a touch screen (or a pen): the details open, the way a double click opens them with a mouse. A
 * finger that moves on, or a press on a control inside the message, is not one.
 */
function useLongPress(fire: () => void) {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const start = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  const clear = () => { clearTimeout(timer.current); timer.current = undefined; start.current = null; };
  useEffect(() => clear, []);
  return {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      if (e.pointerType === "mouse" || e.button !== 0 || (e.target as HTMLElement).closest("button, a, input, audio, video")) return;
      fired.current = false;
      start.current = { x: e.clientX, y: e.clientY };
      clearTimeout(timer.current);
      timer.current = setTimeout(() => { timer.current = undefined; fired.current = true; fire(); }, LONG_PRESS_MS);
    },
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => { if (start.current && Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > 10) clear(); },
    onPointerUp: clear,
    onPointerCancel: clear,
    // The browser's own long-press menu would sit on top of the details.
    onContextMenu: (e: React.MouseEvent) => { if (fired.current || start.current) e.preventDefault(); },
  };
}

const IMAGE_URL_RE =
  /^https:\/\/\S+\.(gif|png|jpe?g|webp)(\?\S*)?$/i;
const GIPHY_RE = /^https:\/\/media\d*\.giphy\.com\//i;
/** GeoCities GIFs from the Wayback Machine (the picker's "Retro" source): tiny pixel art. */
const WAYBACK_GIF_RE = /^https:\/\/web\.archive\.org\/web\/(\d+[a-z_]*\/)?\S+\.gif$/i;
const DATA_IMAGE_SAFE_RE = /^data:image\/(png|jpe?g|gif|webp);/i;
const URL_RE = /https?:\/\/\S+/g;

type ContentType = "text" | "image";

function detectContentType(text: string): ContentType {
  const trimmed = text.trim();
  if (DATA_IMAGE_SAFE_RE.test(trimmed)) return "image";
  if (GIPHY_RE.test(trimmed)) return "image";
  if (IMAGE_URL_RE.test(trimmed)) return "image";
  return "text";
}

/** Pictures that show by themselves: inline data, and the GIF sources the picker uses. */
const autoLoads = (url: string) => DATA_IMAGE_SAFE_RE.test(url) || GIPHY_RE.test(url) || WAYBACK_GIF_RE.test(url);
const hostOf = (url: string) => { try { return new URL(url).host; } catch { return "picture"; } };

function isOnlyEmojis(text: string): boolean {
  const emojiPattern =
    /^(?:[\p{Emoji_Presentation}\p{Extended_Pictographic}]|\u200d|\uFE0F|\s)+$/u;
  return emojiPattern.test(text.trim()) && text.trim().length <= 12;
}

/**
 * A link ends where the sentence around it takes over: trailing punctuation ("see https://x.example/a.") and a
 * closing bracket or quote the link did not open ("(https://x.example/a)") are left as text.
 */
function linkEnd(url: string): string {
  const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  for (;;) {
    const last = url[url.length - 1];
    const opener = pairs[last];
    const count = (c: string) => url.split(c).length - 1;
    if (/[.,;:!?'"*_>]/.test(last) || (opener && count(last) > count(opener))) url = url.slice(0, -1);
    else return url;
  }
}

function renderTextWithLinks(text: string) {
  const parts: (string | React.JSX.Element)[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(URL_RE)) {
    if (match.index! > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    const url = linkEnd(match[0]);
    parts.push(
      <a
        key={match.index}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-link underline hover:decoration-2 break-all"
      >
        {url}
      </a>,
    );
    lastIndex = match.index! + url.length;
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }
  return parts;
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

/** Ticks sit on the bubble, or (`onPicture`) on the dark chip over a picture, which is dark in every theme. */
function CheckIcon({ acked, onPicture = false }: { acked: boolean; onPicture?: boolean }) {
  const ink = onPicture ? (acked ? "text-[#53bdeb]" : "text-[hsla(0,0%,100%,0.9)]") : acked ? "text-link" : "text-text-primary/65";
  return (
    <svg
      width="16"
      height="11"
      viewBox="0 0 16 11"
      className={`shrink-0 ${ink}`}
      fill="none"
    >
      <path
        d="M11.07 0.66L4.98 6.75L2.91 4.68L1.5 6.09L4.98 9.57L12.48 2.07L11.07 0.66Z"
        fill="currentColor"
      />
      {acked && (
        <path
          d="M14.07 0.66L7.98 6.75L7.05 5.82L5.64 7.23L7.98 9.57L15.48 2.07L14.07 0.66Z"
          fill="currentColor"
        />
      )}
    </svg>
  );
}

function CallEventIcon({ type, hasVideo }: { type: string; hasVideo?: boolean }) {
  const isVideo = hasVideo;
  const isMissed = type === "call_missed" || type === "call_rejected";
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

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) {
    return `${seconds}s`;
  }
  return `${minutes}m ${seconds}s`;
}

/**
 * What can be done to a message, behind its ⋮: its details, and forgetting it here. The deletion is local, so the
 * menu says so before it happens: nothing is sent, and the contact keeps their copy.
 */
function MessageMenu({ onDelete, onDetails, align }: { onDelete?: () => void; onDetails: () => void; align: "left" | "right" }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useOutsideDismiss(ref, confirm, () => setConfirm(false));

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
      <Menu open={open} onClose={() => setOpen(false)} anchorRef={ref} testId="message-menu" align={align === "left" ? "end" : "start"} prefer="up" focusFirst label={t("chat.message.options")}>
        <MenuItem testId="message-details" onClick={() => { setOpen(false); onDetails(); }}
          icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 16v-4M12 8h.01" /></svg>}>
          {t("chat.message.details")}
        </MenuItem>
        {onDelete && <MenuItem testId="message-delete" danger onClick={() => { setOpen(false); setConfirm(true); }}
          icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18" /><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" /><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" /></svg>}>
          {t("chat.deleteMessage")}
        </MenuItem>}
      </Menu>
      {confirm && onDelete && (
        <div
          data-testid="message-delete-menu"
          // No `translate` of its own: the fade-in animation sets `transform`.
          className={`absolute z-20 bottom-full mb-1 w-[210px] p-3 rounded-lg bg-surface border border-border shadow-lg animate-fade-in ${
            align === "left" ? "start-0" : "end-0"
          }`}
        >
          <p className="m-0 mb-2 text-[11px] leading-snug text-text-muted">{t("chat.deleteMessageHint")}</p>
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setConfirm(false)}
              className="px-2 py-0.5 rounded border border-border bg-surface-hover text-text-muted text-xs font-bold hover:text-text-secondary transition-colors cursor-pointer"
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              data-testid="message-delete-confirm"
              onClick={() => {
                setConfirm(false);
                onDelete();
              }}
              className="px-2 py-0.5 rounded border border-danger/30 bg-danger/20 text-danger text-xs font-bold hover:bg-danger/30 transition-colors cursor-pointer"
            >
              {t("common.delete")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function MessageBubble({ message, peerAck = 0, peerPubKey = "", peerNick = "", onDelete, linkId }: MessageBubbleProps) {
  // Only what arrives while you watch moves; history is just there.
  const [enter] = useState(() =>
    Date.now() - message.timestamp < 5000
      ? message.sender === "me"
        ? "animate-bubble-in-right"
        : "animate-bubble-in-left"
      : "",
  );
  const money = useMemo(() => (message.paymentId || message.file ? null : findMoney(message.text)), [message.paymentId, message.file, message.text]);
  const [details, setDetails] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const openDetails = () => setDetails(true);
  const press = useLongPress(openDetails);
  const [imgError, setImgError] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const isMe = message.sender === "me";
  const isSystem = message.sender === "system";
  const isAcked = isMe && (message.delivery ? message.delivery === "delivered" : peerAck >= message.timestamp);
  const time = new Date(message.timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  const contentType = imgError || message.file || message.paymentId ? "text" : detectContentType(message.text);
  const detailsPanel = details && (
    <MessageDetailsPanel message={message} linkId={linkId ?? (peerPubKey ? engine.linkByPeer(peerPubKey)?.id : undefined)}
      picture={contentType === "image"} onClose={() => setDetails(false)} returnFocus={rowRef.current} />
  );
  const rowProps = { ref: rowRef, onDoubleClick: openDetails, ...press, "data-details-open": details || undefined };

  if (isSystem && message.systemEvent?.type === "join") {
    const pubKeyShort = message.systemEvent.pubKey
      ? publicKeyLabel(message.systemEvent.pubKey)
      : "";
    
    return (
      <div {...rowProps} data-message-row data-sender="system" className={`group flex items-center justify-center gap-1 mb-3.5 px-[63px] max-md:px-2.5 ${enter}`}>
        <div className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs bg-blue-500/10 text-link ${details ? "ring-2 ring-accent" : ""}`}>
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
          <span>
            <span className="font-mono font-semibold">{pubKeyShort}</span>
            {" "}joined the chat
          </span>
          <span className="text-text-muted text-[10px]">{time}</span>
        </div>
        <MessageMenu onDelete={onDelete} onDetails={openDetails} align="right" />
        {detailsPanel}
      </div>
    );
  }

  if (isSystem && message.callEvent) {
    const { type, hasVideo, duration } = message.callEvent;
    const isMissed = type === "call_missed" || type === "call_rejected";
    
    return (
      <div {...rowProps} data-message-row data-sender="system" className={`group flex items-center justify-center gap-1 mb-3.5 px-[63px] max-md:px-2.5 ${enter}`}>
        <div
          className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs ${
            isMissed
              ? "bg-danger/10 text-danger"
              : "bg-surface-alt/80 text-text-secondary"
          } ${details ? "ring-2 ring-accent" : ""}`}
        >
          <CallEventIcon type={type} hasVideo={hasVideo} />
          <span>{message.text}</span>
          {duration !== undefined && duration > 0 && (
            <span className="text-text-muted">({formatDuration(duration)})</span>
          )}
          <span className="text-text-muted text-[10px]">{time}</span>
        </div>
        <MessageMenu onDelete={onDelete} onDetails={openDetails} align="right" />
        {detailsPanel}
      </div>
    );
  }

  const bigEmoji = contentType === "text" && isOnlyEmojis(message.text);

  const timestampEl = (
    <span className="msg-meta inline-flex items-center gap-[3px] float-end relative top-[4px] ms-[8px] select-none">
      <span className="text-[11px] leading-none text-text-primary/65">
        {time}
      </span>
      {isMe && <CheckIcon acked={isAcked} />}
    </span>
  );

  return (
    <div
      {...rowProps}
      data-message-row
      data-sender={isMe ? "me" : "peer"}
      className={`group flex items-start gap-1 ${isMe ? "justify-end" : "justify-start"} mb-3.5 px-[63px] max-md:px-2.5 ${enter}`}
    >
      {isMe && <MessageMenu onDelete={onDelete} onDetails={openDetails} align="left" />}
      {/* Bubbles take the theme's colours; what is inside reads on either one (see e2e/web/bubble-contrast.spec.ts). */}
      <div
        data-message-bubble
        className={`relative max-w-[85%] min-w-[80px] ${
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
        } ${details ? "ring-2 ring-accent" : ""}`}
        style={{
          boxShadow: "0 1px 0.5px rgba(11,20,26,0.13)",
        }}
      >
        <TailSvg side={isMe ? "right" : "left"} />

        {/* A paired message carries no name of its own: the contact has one name, known from the link. */}
        {(message.nick || peerNick) && !isMe && (
          <div data-testid="message-nick" className="text-accent-hover text-[12.8px] font-medium mb-[2px] leading-[22px]">
            ~{message.nick || peerNick}
          </div>
        )}

        {message.paymentId ? (
          <div className="clearfix">
            <PaymentBubble paymentId={message.paymentId} peerPubKey={peerPubKey} fallbackText={message.text} />
            {timestampEl}
          </div>
        ) : message.file?.voice ? (
          <div className="clearfix">
            <VoiceBubble file={{ ...message.file, voice: message.file.voice }} sender={isMe ? "me" : "peer"} />
            {timestampEl}
          </div>
        ) : message.file ? (
          <div className="clearfix">
            <FileBubble file={message.file} peerName={message.nick || peerNick || undefined} />
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
              Show picture · {hostOf(message.text.trim())}
            </button>
            {timestampEl}
          </div>
        ) : contentType === "image" ? (
          <div className="relative">
            <img
              src={message.text.trim()}
              alt=""
              className="rounded-[4px] max-w-[min(330px,72vw)] min-w-[120px] max-h-[330px] object-contain block"
              style={WAYBACK_GIF_RE.test(message.text.trim()) ? { imageRendering: "pixelated" } : undefined}
              loading="lazy"
              onError={() => setImgError(true)}
            />
            <span data-picture-time className="absolute bottom-[4px] end-[6px] inline-flex items-center gap-[3px] bg-[rgba(11,20,26,0.55)] rounded-full px-[6px] py-[3px]">
              <span className="text-[11px] leading-none text-[hsla(0,0%,100%,0.9)]">
                {time}
              </span>
              {isMe && <CheckIcon acked={isAcked} onPicture />}
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
          <div className="clearfix">
            <span data-testid="message-text" className="text-[14.2px] leading-[19px] wrap-break-word whitespace-pre-wrap">
              {renderTextWithLinks(message.text)}
            </span>
            {timestampEl}
          </div>
        )}

        {isMe && message.delivery && <div className="clear-both pt-1 text-xs text-text-primary/65" role="status">
          <span>{message.delivery === "delivered" ? "Received by peer" : message.delivery === "held" ? "Held · waiting for your contact" : message.delivery === "sent" ? "Sent · waiting for receipt" : message.delivery === "sending" ? "Sending…" : message.delivery === "queued" ? "Not confirmed yet · sends again by itself" : message.delivery === "waiting" ? "Sends when live" : "Delivery unconfirmed"}</span>
          {message.delivery === "waiting" && <>
            {message.deliveryError && <span className="block" data-testid="waiting-reason">{message.deliveryError}</span>}
            {/* Cancelling is deleting what never left: the chat's own delete, so the list forgets it too. */}
            <button className="underline text-link cursor-pointer" data-testid="cancel-waiting" onClick={() => {
              if (onDelete) { onDelete(); return; }
              const link = engine.linkByPeer(peerPubKey);
              if (link) void engine.call("deleteMessage", { linkId: link.id, messageId: message.id }).catch(() => {});
            }}>Cancel</button>
          </>}
          {message.delivery === "failed" && <>
            <span className="block">{message.deliveryError}</span>
            <button className="underline text-link cursor-pointer" onClick={() => {
              const link = engine.linkByPeer(peerPubKey);
              if (link) void engine.call("retryMessage", { linkId: link.id, messageId: message.id }).catch(() => {});
            }}>Retry message</button>
          </>}
        </div>}
      </div>
      {!isMe && <MessageMenu onDelete={onDelete} onDetails={openDetails} align="right" />}
      {detailsPanel}
    </div>
  );
}
