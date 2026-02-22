import { useState, useRef, useEffect, useCallback } from "react";
import { EmojiPicker } from "./EmojiPicker";
import { GiphyPicker } from "./GiphyPicker";

interface MessageInputProps {
  onSend: (text: string) => Promise<string | null>;
  disabled?: boolean;
  maxLength?: number;
}

const DEFAULT_MAX = 500;
const TOAST_DURATION = 5_000;

export function MessageInput({
  onSend,
  disabled,
  maxLength = DEFAULT_MAX,
}: MessageInputProps) {
  const [text, setText] = useState("");
  const [showEmoji, setShowEmoji] = useState(false);
  const [showGiphy, setShowGiphy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

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
    const err = await onSend(text);
    if (err) {
      showToast(err);
    } else {
      setText("");
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
    if (value.length <= maxLength) {
      setText(value);
    }
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 120)}px`;
    }
  };

  const handleEmojiSelect = useCallback(
    (emoji: string) => {
      const newText = text + emoji;
      if (newText.length <= maxLength) {
        setText(newText);
      }
      textareaRef.current?.focus();
    },
    [text, maxLength],
  );

  const handleGiphySelect = useCallback(
    async (url: string) => {
      const err = await onSend(url);
      if (err) {
        showToast(err);
      }
      setShowGiphy(false);
      textareaRef.current?.focus();
    },
    [onSend, showToast],
  );

  const closeAll = () => {
    setShowEmoji(false);
    setShowGiphy(false);
  };

  const toggleEmoji = () => {
    setShowGiphy(false);
    setShowEmoji((v) => !v);
  };

  const toggleGiphy = () => {
    setShowEmoji(false);
    setShowGiphy((v) => !v);
  };

  const remaining = maxLength - text.length;

  return (
    <div className="bg-panel-header px-4 py-2.5 shrink-0 relative">
      {toast && (
        <div className="absolute bottom-full left-4 right-4 mb-2 z-50 animate-fade-in">
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
        <div className="flex items-center gap-0.5 shrink-0 h-10">
          <button
            onClick={toggleEmoji}
            disabled={disabled}
            className={`w-9 h-9 flex items-center justify-center rounded-full transition-colors cursor-pointer border-none ${
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

          <button
            onClick={toggleGiphy}
            disabled={disabled}
            className={`w-9 h-9 flex items-center justify-center rounded-full transition-colors cursor-pointer border-none ${
              showGiphy
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

        </div>

        {/* Text input */}
        <div className="flex-1 relative flex items-center">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            onFocus={closeAll}
            placeholder={disabled ? "Chat burned" : "Type a message"}
            disabled={disabled}
            rows={1}
            className="w-full bg-input-bg border-none rounded-lg px-3 py-2 text-[15px] text-text-primary placeholder-text-muted resize-none focus:outline-none disabled:opacity-50 min-h-10"
          />
          {remaining < 100 && (
            <span
              className={`absolute right-2.5 bottom-1.5 text-[10px] ${remaining < 50 ? "text-danger" : "text-text-muted"}`}
            >
              {remaining}
            </span>
          )}
        </div>

        {/* Send button */}
        <button
          onClick={handleSubmit}
          disabled={disabled || !text.trim()}
          className="w-10 h-10 flex items-center justify-center bg-accent rounded-full text-[#111b21] hover:bg-accent-hover transition-colors disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer shrink-0"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
          </svg>
        </button>

        {/* Pickers */}
        {showEmoji && (
          <div className="absolute bottom-full left-0 mb-2 z-50">
            <EmojiPicker
              onSelect={handleEmojiSelect}
              onClose={() => setShowEmoji(false)}
            />
          </div>
        )}
        {showGiphy && (
          <GiphyPicker
            onSelect={handleGiphySelect}
            onClose={() => setShowGiphy(false)}
          />
        )}
      </div>
    </div>
  );
}
