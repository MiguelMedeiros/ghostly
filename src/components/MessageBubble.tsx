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
    /^[\p{Emoji_Presentation}\p{Extended_Pictographic}\u200d\uFE0F\s]+$/u;
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

export function MessageBubble({ message, peerAck = 0 }: MessageBubbleProps) {
  const [showTech, setShowTech] = useState(false);
  const [imgError, setImgError] = useState(false);
  const isMe = message.sender === "me";
  const isAcked = isMe && peerAck >= message.timestamp;
  const time = new Date(message.timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

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
        className={`relative max-w-[85%] min-w-[80px] rounded-[7.5px] ${
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
