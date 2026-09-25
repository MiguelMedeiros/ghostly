import { getSessionDraft, setSessionDraft } from "../lib/storage";
import { useState, useRef, useEffect, useCallback, type ReactNode } from "react";
import { EmojiPicker } from "./EmojiPicker";
import { GifPicker } from "./GifPicker";
import { PaymentComposer } from "./PaymentComposer";
import { ComposerIdentityButton, ComposerIdentityPicker } from "./identities/ComposerIdentities";
import { VoiceRecorderButton } from "./voice/VoiceRecorderButton";
import { canRecordVoice } from "../lib/voiceRecorder";
import type { VoiceMeta } from "@ghostly/core";

interface MessageInputProps {
  draftId?: string;
  onSend: (text: string) => Promise<string | null>;
  disabled?: boolean;
  disabledPlaceholder?: string;
  maxLength?: number;
  maxBytes?: number;
  /** Present when the platform can send files; returns an error message or null. */
  fileUnavailable?: string;
  paymentsUnavailable?: string;
  /** With `voice`, the file is a voice message recorded here (the mic replaces send while the text is empty). */
  onSendFile?: (file: File, voice?: VoiceMeta) => Promise<string | null>;
  /** Present when the platform has a wallet. */
  payments?: {
    reviewContext?: {wallet:import("../lib/platform").WalletPlatform;peer:string;linkId:string};
    balance: number;
    /** Who the chat is with, as the chat shows them. */
    contact?: string;
    onSend: (amount: number, memo: string) => Promise<string | null>;
    onRequest: (amount: number, memo: string, method?: "cashu" | "arkade" | "usdt" | "bark" | "bitcoin" | "fedimint" | "spark") => Promise<string | null>;
  };
  /** A composer of its own for ⚡ instead of the chat's (a group chooses whom to pay first). */
  paymentComposer?: (close: () => void) => ReactNode;
  /** A paired chat: which of this profile's identities its contact sees, next to ⚡. */
  identities?: { peerKey: string; contact: string };
}

const DEFAULT_MAX = 500;
const TOAST_DURATION = 5_000;

export function MessageInput({
  draftId,
  onSend,
  disabled,
  disabledPlaceholder = "Message…",
  maxLength = DEFAULT_MAX,
  maxBytes,
  onSendFile,
  payments,
  paymentComposer,
  identities,
  fileUnavailable,
  paymentsUnavailable,
}: MessageInputProps) {
  const [showPayment, setShowPayment] = useState(false);
  const [showIdentities, setShowIdentities] = useState(false);
  const identitiesButtonRef = useRef<HTMLButtonElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(() => draftId ? getSessionDraft(draftId) : "");
  const emojiButtonRef = useRef<HTMLButtonElement>(null);
  const [showEmoji, setShowEmoji] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [showGif, setShowGif] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [canRecord] = useState(canRecordVoice);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  useEffect(() => {
    if (draftId) setSessionDraft(draftId, text);
    const input=textareaRef.current;
    if(input && text) { input.style.height="auto"; input.style.height=`${Math.min(input.scrollHeight,120)}px`; }
  }, [draftId,text]);

  const showToast = useCallback((msg: string) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast(msg);
    toastTimerRef.current = setTimeout(
      () => setToast(null),
      TOAST_DURATION,
    );
  }, []);

  const handleSubmit = async () => {
    if (!text.trim() || disabled) return;
    const bytes = new TextEncoder().encode(text.trim()).length;
    if (maxBytes && bytes > maxBytes) { showToast(`This text is ${bytes} UTF-8 bytes. DHT allows up to ${maxBytes}; shorten it or use a live connection. Your draft is kept.`); return; }
    const err = await onSend(text);
    if (err) {
      showToast(err);
    } else {
      setText("");
      if(draftId) setSessionDraft(draftId, "");
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
      }
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    if (value.length <= Math.max(maxLength, 16_384)) {
      setText(value);
    } else if (value.length - text.length > 1) {
      showToast(
        maxLength > DEFAULT_MAX
          ? `That is too long to send (${value.length.toLocaleString()} characters, the limit is ${maxLength.toLocaleString()}).`
          : "That is too long for the DHT. Once you are connected peer to peer, long invoices and ecash tokens fit.",
      );
    }
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 120)}px`;
    }
  };

  const handleEmojiSelect = useCallback(
    (emoji: string) => {
      const newText = text + emoji;
      if (newText.length <= Math.max(maxLength, 16_384)) {
        setText(newText);
      }
      textareaRef.current?.focus();
    },
    [text, maxLength],
  );

  const handleGifSelect = useCallback(
    async (url: string) => {
      const err = await onSend(url);
      if (err) {
        showToast(err);
      }
      setShowGif(false);
      textareaRef.current?.focus();
    },
    [onSend, showToast],
  );

  const closeAll = () => {
    setShowEmoji(false);
    setShowGif(false);
    setShowIdentities(false);
  };

  const toggleEmoji = () => {
    setShowGif(false);
    setShowEmoji((v) => !v);
  };

  const toggleGif = () => {
    setShowEmoji(false);
    setShowGif((v) => !v);
  };

  const remaining = maxBytes ? maxBytes - new TextEncoder().encode(text.trim()).length : maxLength - text.length;

  return (
    <div className="bg-panel-header px-4 max-md:px-2 py-2.5 composer-safe shrink-0 relative">
      {toast && (
        <div role="alert" className="absolute bottom-full left-4 right-4 mb-2 z-50 animate-fade-in">
          <div className="bg-[#3b2020] border border-danger/30 rounded-lg px-4 py-2.5 flex items-start gap-2 shadow-lg">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="text-danger shrink-0 mt-0.5"
            >
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <span className="text-[13px] text-text-primary leading-snug flex-1">
              {toast}
            </span>
            <button
              onClick={() => {
                setToast(null);
                if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
              }}
              className="text-text-muted hover:text-text-primary transition-colors cursor-pointer bg-transparent border-none p-0 text-lg leading-none shrink-0"
            >
              &times;
            </button>
          </div>
        </div>
      )}
      <div className="flex items-end gap-2 relative">
        {/* Left action buttons */}
        <div className="flex items-center gap-0.5 max-md:gap-0 shrink-0 h-10 max-md:h-11">
          {/* Phones keep the input wide: GIFs, sats and files wait behind a plus. */}
          <button
            onClick={() => setShowMore((v) => !v)}
            disabled={disabled}
            className={`md:hidden w-10 h-11 flex items-center justify-center rounded-full cursor-pointer border-none bg-transparent transition-transform disabled:opacity-30 ${
              showMore ? "rotate-45 text-accent" : "text-text-secondary"
            }`}
            title="More"
            data-testid="composer-more"
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
          <button
            ref={emojiButtonRef}
            aria-expanded={showEmoji}
            aria-haspopup="dialog"
            onClick={toggleEmoji}
            disabled={disabled}
            className={`w-9 h-9 max-md:w-10 max-md:h-11 flex items-center justify-center rounded-full transition-colors cursor-pointer border-none ${
              showEmoji
                ? "bg-accent/20 text-accent"
                : "bg-transparent text-text-secondary hover:text-text-primary hover:bg-surface-hover"
            } disabled:opacity-30 disabled:cursor-not-allowed`}
            title="Emoji"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <circle cx="12" cy="12" r="10" />
              <path d="M8 14s1.5 2 4 2 4-2 4-2" />
              <line x1="9" y1="9" x2="9.01" y2="9" strokeWidth="2.5" strokeLinecap="round" />
              <line x1="15" y1="9" x2="15.01" y2="9" strokeWidth="2.5" strokeLinecap="round" />
            </svg>
          </button>

          <div className={`composer-more ${showMore ? "composer-more-open" : ""}`} onClick={() => setShowMore(false)}>
          <button
            onClick={toggleGif}
            disabled={disabled}
            className={`w-9 h-9 max-md:w-10 max-md:h-11 flex items-center justify-center rounded-full transition-colors cursor-pointer border-none ${
              showGif
                ? "bg-accent/20 text-accent"
                : "bg-transparent text-text-secondary hover:text-text-primary hover:bg-surface-hover"
            } disabled:opacity-30 disabled:cursor-not-allowed`}
            title="GIF"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <rect x="2" y="4" width="20" height="16" rx="3" />
              <text x="12" y="15" textAnchor="middle" fill="currentColor" stroke="none" fontSize="8" fontWeight="bold" fontFamily="sans-serif">
                GIF
              </text>
            </svg>
          </button>

          {(payments || paymentComposer) && (
            <button
              onClick={() => { setShowIdentities(false); setShowPayment((v) => !v); }}
              disabled={disabled || !!paymentsUnavailable}
              data-testid="payment-button"
              className={`w-9 h-9 max-md:w-10 max-md:h-11 flex items-center justify-center rounded-full transition-colors cursor-pointer border-none ${
                showPayment
                  ? "bg-accent/20 text-accent"
                  : "bg-transparent text-text-secondary hover:text-text-primary hover:bg-surface-hover"
              } disabled:opacity-30 disabled:cursor-not-allowed`}
              aria-label="Send or request sats"
              title={paymentsUnavailable ?? "Send or request sats"}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
              </svg>
            </button>
          )}

          {identities && (
            <ComposerIdentityButton peerKey={identities.peerKey} buttonRef={identitiesButtonRef} open={showIdentities}
              onToggle={() => { setShowPayment(false); setShowIdentities((v) => !v); }} />
          )}

          {onSendFile && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                data-testid="file-input"
                disabled={disabled || !!fileUnavailable}
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (!file || disabled || fileUnavailable) return;
                  const err = await onSendFile(file);
                  if (err) showToast(err);
                }}
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={disabled || !!fileUnavailable}
                className="w-9 h-9 max-md:w-10 max-md:h-11 flex items-center justify-center rounded-full transition-colors cursor-pointer border-none bg-transparent text-text-secondary hover:text-text-primary hover:bg-surface-hover disabled:opacity-30 disabled:cursor-not-allowed"
                aria-label="Send a file"
                title={fileUnavailable ?? "Send a file"}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                </svg>
              </button>
            </>
          )}
          </div>

        </div>

        {/* Text input */}
        <div className="flex-1 relative flex items-center">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            onFocus={closeAll}
            placeholder={disabled ? disabledPlaceholder : "Message…"}
            disabled={disabled}
            rows={1}
            className="w-full bg-input-bg border-none rounded-lg px-3 py-2 max-md:py-2.5 text-[15px] text-text-primary placeholder-text-muted resize-none focus:outline-none disabled:opacity-50 min-h-10 max-md:min-h-11 max-md:rounded-3xl"
          />
          {remaining < 100 && (
            <span
              className={`absolute right-2.5 bottom-1.5 text-[10px] ${remaining < 50 ? "text-danger" : "text-text-muted"}`}
            >
              {remaining}{maxBytes ? " B" : ""}
            </span>
          )}
        </div>

        {/* Send button; the mic while there is nothing to send, as in WhatsApp */}
        {onSendFile && canRecord && !text.trim() ? (
          <VoiceRecorderButton
            onSend={(file, voice) => onSendFile(file, voice)}
            unavailable={fileUnavailable}
            disabled={disabled}
            onError={showToast}
            onActiveChange={(active) => { if (active) { closeAll(); setShowMore(false); setShowPayment(false); } }}
          />
        ) : <button
          aria-label="Send message"
          onClick={handleSubmit}
          disabled={disabled || !text.trim()}
          className="w-10 h-10 max-md:w-11 max-md:h-11 flex items-center justify-center bg-accent rounded-full text-[#111b21] hover:bg-accent-hover transition-colors disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer shrink-0"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
          </svg>
        </button>}

        {/* Pickers */}
        {showEmoji && (
            <EmojiPicker
              anchorRef={emojiButtonRef}
              onSelect={handleEmojiSelect}
              onClose={() => { setShowEmoji(false); textareaRef.current?.focus(); }}
            />
        )}
        {showPayment && paymentComposer && !paymentsUnavailable && !disabled && paymentComposer(() => setShowPayment(false))}
        {showPayment && !paymentComposer && payments && !paymentsUnavailable && !disabled && (
          <PaymentComposer
            reviewContext={payments.reviewContext}
            balance={payments.balance}
            contact={payments.contact}
            onSend={payments.onSend}
            onRequest={payments.onRequest}
            onClose={() => setShowPayment(false)}
          />
        )}

        {showIdentities && identities && (
          <ComposerIdentityPicker peerKey={identities.peerKey} contact={identities.contact} anchorRef={identitiesButtonRef}
            onClose={() => setShowIdentities(false)} />
        )}

        {showGif && (
          <GifPicker
            onSelect={handleGifSelect}
            onClose={() => setShowGif(false)}
          />
        )}
      </div>
    </div>
  );
}
