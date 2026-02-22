import React, { useState } from "react";
import type { ChatMessage } from "../lib/types";

interface MessageBubbleProps {
  message: ChatMessage;
  peerAck?: number;
}

const IMAGE_URL_RE =
  /^https?:\/\/\S+\.(gif|png|jpe?g|webp|svg)(\?\S*)?$/i;
const GIPHY_RE = /^https?:\/\/media\d*\.giphy\.com\//i;
const DATA_IMAGE_RE = /^data:image\//i;
const URL_RE = /https?:\/\/\S+/g;

type ContentType = "text" | "image";

function detectContentType(text: string): ContentType {
  const trimmed = text.trim();
  if (DATA_IMAGE_RE.test(trimmed)) return "image";
  if (GIPHY_RE.test(trimmed)) return "image";
  if (IMAGE_URL_RE.test(trimmed)) return "image";
  return "text";
}

function isOnlyEmojis(text: string): boolean {
  const emojiPattern =
    /^(?:[\p{Emoji_Presentation}\p{Extended_Pictographic}]|\u200d|\uFE0F|\s)+$/u;
  return emojiPattern.test(text.trim()) && text.trim().length <= 12;
}

function renderTextWithLinks(text: string) {
  const parts: (string | React.JSX.Element)[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(URL_RE)) {
    if (match.index! > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    const url = match[0];
    parts.push(
      <a
        key={match.index}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-[#53bdeb] underline hover:text-[#7fcef1] break-all"
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
  const color = side === "right" ? "#005c4b" : "#202c33";
  if (side === "right") {
    return (
      <span className="absolute top-0 -right-[8px] block w-[8px] h-[13px] overflow-hidden">
        <svg viewBox="0 0 8 13" width="8" height="13" className="block">
          <path d="M5 0H0V13C0 13 1.8 8.5 5 4.5C6.4 2.7 8 1 8 1L5 0Z" fill={color} />
        </svg>
      </span>
    );
  }
  return (
    <span className="absolute top-0 -left-[8px] block w-[8px] h-[13px] overflow-hidden">
      <svg viewBox="0 0 8 13" width="8" height="13" className="block">
        <path d="M3 0H8V13C8 13 6.2 8.5 3 4.5C1.6 2.7 0 1 0 1L3 0Z" fill={color} />
      </svg>
    </span>
  );
}

function CheckIcon({ acked }: { acked: boolean }) {
  return (
    <svg
      width="16"
      height="11"
      viewBox="0 0 16 11"
      className={`shrink-0 ${acked ? "text-[#53bdeb]" : "text-[hsla(0,0%,100%,0.5)]"}`}
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
    <span className="inline-flex items-center justify-center mr-2">
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
          className={`ml-[-4px] mt-[6px] ${isMissed ? "text-danger" : "text-accent"}`}
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
          className="ml-[-4px] mt-[6px] text-accent"
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

export function MessageBubble({ message, peerAck = 0 }: MessageBubbleProps) {
  const [showTech, setShowTech] = useState(false);
  const [imgError, setImgError] = useState(false);
  const isMe = message.sender === "me";
  const isSystem = message.sender === "system";
  const isAcked = isMe && peerAck >= message.timestamp;
  const time = new Date(message.timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  if (isSystem && message.systemEvent?.type === "join") {
    const pubKeyShort = message.systemEvent.pubKey
      ? message.systemEvent.pubKey.slice(0, 8) + "..."
      : "";
    
    return (
      <div className="flex justify-center mb-[2px] px-[63px]">
        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs bg-blue-500/10 text-blue-400">
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
            <span className="font-mono text-blue-300">{pubKeyShort}</span>
            {" "}joined the chat
          </span>
          <span className="text-text-muted text-[10px]">{time}</span>
        </div>
      </div>
    );
  }

  if (isSystem && message.callEvent) {
    const { type, hasVideo, duration } = message.callEvent;
    const isMissed = type === "call_missed" || type === "call_rejected";
    
    return (
      <div className="flex justify-center mb-[2px] px-[63px]">
        <div
          className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs ${
            isMissed
              ? "bg-danger/10 text-danger"
              : "bg-surface-alt/80 text-text-secondary"
          }`}
        >
          <CallEventIcon type={type} hasVideo={hasVideo} />
          <span>{message.text}</span>
          {duration !== undefined && duration > 0 && (
            <span className="text-text-muted">({formatDuration(duration)})</span>
          )}
          <span className="text-text-muted text-[10px]">{time}</span>
        </div>
      </div>
    );
  }

  const contentType = imgError ? "text" : detectContentType(message.text);
  const bigEmoji = contentType === "text" && isOnlyEmojis(message.text);

  const timestampEl = (
    <span className="msg-meta inline-flex items-center gap-[3px] float-right relative top-[4px] ml-[8px] select-none">
      <span className="text-[11px] leading-none text-[hsla(0,0%,100%,0.45)]">
        {time}
      </span>
      {isMe && <CheckIcon acked={isAcked} />}
    </span>
  );

  return (
    <div
      className={`flex ${isMe ? "justify-end" : "justify-start"} mb-[2px] px-[63px]`}
      onDoubleClick={() => message.meta && setShowTech((v) => !v)}
    >
      <div
        className={`relative max-w-[85%] min-w-[80px] ${
          isMe
            ? "rounded-tl-[7.5px] rounded-bl-[7.5px] rounded-br-[7.5px]"
            : "rounded-tr-[7.5px] rounded-bl-[7.5px] rounded-br-[7.5px]"
        } ${
          contentType === "image"
            ? "p-[3px] pb-[3px]"
            : "px-[9px] pt-[6px] pb-[8px]"
        } ${
          isMe
            ? "bg-[#005c4b] text-text-primary"
            : "bg-[#202c33] text-text-primary"
        }`}
        style={{
          boxShadow: "0 1px 0.5px rgba(11,20,26,0.13)",
        }}
      >
        <TailSvg side={isMe ? "right" : "left"} />

        {message.nick && !isMe && (
          <div className="text-accent-hover text-[12.8px] font-medium mb-[2px] leading-[22px]">
            ~{message.nick}
          </div>
        )}

        {contentType === "image" ? (
          <div className="relative">
            <img
              src={message.text.trim()}
              alt=""
              className="rounded-[4px] max-w-[330px] min-w-[120px] max-h-[330px] object-contain block"
              loading="lazy"
              onError={() => setImgError(true)}
            />
            <span className="absolute bottom-[4px] right-[6px] inline-flex items-center gap-[3px] bg-[rgba(11,20,26,0.55)] rounded-full px-[6px] py-[3px]">
              <span className="text-[11px] leading-none text-[hsla(0,0%,100%,0.9)]">
                {time}
              </span>
              {isMe && <CheckIcon acked={isAcked} />}
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
            <span className="text-[14.2px] leading-[19px] wrap-break-word whitespace-pre-wrap">
              {renderTextWithLinks(message.text)}
            </span>
            {timestampEl}
          </div>
        )}

        {showTech && message.meta && (
          <div className="mt-[6px] pt-[6px] border-t border-[hsla(0,0%,100%,0.08)] text-[9px] text-text-secondary space-y-[2px] animate-fade-in font-mono clear-both">
            <div>
              <span className="text-[#00a884]/60">id:</span> {message.id}
            </div>
            <div>
              <span className="text-[#00a884]/60">ts:</span>{" "}
              {message.timestamp}
            </div>
            <div>
              <span className="text-[#00a884]/60">dir:</span>{" "}
              {isMe ? "outbound" : "inbound"}
            </div>
            <div>
              <span className="text-[#00a884]/60">ack:</span>{" "}
              {isMe
                ? isAcked
                  ? `ACKed (${peerAck})`
                  : `Pending`
                : "N/A"}
            </div>
            <div>
              <span className="text-[#00a884]/60">dht:</span>{" "}
              <span className="break-all">
                {message.meta.dhtKey.slice(0, 20)}...
              </span>
            </div>
            <div>
              <span className="text-[#00a884]/60">dns:</span>{" "}
              {message.meta.dnsRecords.join(", ")}
            </div>
            <div>
              <span className="text-[#00a884]/60">enc:</span> NaCl secretbox
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
