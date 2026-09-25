import { getSessionDraft, setSessionDraft } from "../lib/storage";
import { useState, useRef, useEffect, useLayoutEffect, useCallback, type ReactNode } from "react";
import { PaymentComposer } from "./PaymentComposer";
import { ComposerIdentityPicker, useSharedIdentityCount } from "./identities/ComposerIdentities";
import { VoiceRecorderButton } from "./voice/VoiceRecorderButton";
import { canRecordVoice } from "../lib/voiceRecorder";
import type { VoiceMeta } from "@ghostly/core";
import { useI18n } from "../contexts/I18nContext";
import { useIsMobile } from "../hooks/useIsMobile";
import { ComposerMenu, type ComposerAction } from "./composer/ComposerMenu";
import { ExpressionPanel } from "./composer/ExpressionPanel";
import { CameraCapture, cameraByFileInput, useHasCamera } from "./composer/CameraCapture";
import { CameraGlyph, DocumentGlyph, IdentityGlyph, MediaGlyph, PaymentGlyph, ServicesGlyph, SmileIcon } from "./composer/icons";
import type { ComposerServices } from "./composer/servicesRow";
import "./composer/composer.css";

interface MessageInputProps {
  draftId?: string;
  onSend: (text: string) => Promise<string | null>;
  disabled?: boolean;
  disabledPlaceholder?: string;
  maxLength?: number;
  maxBytes?: number;
  /**
   * What the DHT carries while the chat is not live: past it the counter turns amber and the text is still
   * sent, waiting for a live connection (or held) instead of being refused.
   */
  softBytes?: number;
  /** Present when the platform can send files; returns an error message or null. */
  fileUnavailable?: string;
  /**
   * Why paying is not possible in this chat now. The + row is greyed with it, unless the chat chooses its own ways of
   * paying (`payments.onSaveMethods`): then the row still opens, on the cards that say why, and on Accept.
   */
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
    /** Why paying is not possible now (a request still is): shown on the Pay side. */
    sendUnavailable?: string;
    /** Saves which ways of paying this chat accepts, from the composer's Accept side. */
    onSaveMethods?: (methods: import("../lib/chatPayments").ChatPaymentMethods) => Promise<void>;
  };
  /** A composer of its own for payments instead of the chat's (a group chooses whom to pay first). */
  paymentComposer?: (close: () => void) => ReactNode;
  /** A paired chat: which of this profile's identities its contact sees, from the + menu. */
  identities?: { peerKey: string; contact: string };
  /** A 1:1 chat's shared apps, from the + menu: which of yours the contact can open, and theirs (`composerServices`). */
  services?: ComposerServices;
}

const DEFAULT_MAX = 500;
const TOAST_DURATION = 5_000;

/**
 * The chat's composer, laid out as WhatsApp's: [+] [emoji/GIF] [message] in one rounded field, and the mic (send
 * once there is text) beside it. The + opens what else can go into the chat (a payment, an identity, shared apps, a
 * document, photos, the camera); the smiley opens one panel with emoji and GIFs.
 */
export function MessageInput({
  draftId,
  onSend,
  disabled,
  disabledPlaceholder = "Message…",
  maxLength = DEFAULT_MAX,
  maxBytes,
  softBytes,
  onSendFile,
  payments,
  paymentComposer,
  identities,
  services,
  fileUnavailable,
  paymentsUnavailable,
}: MessageInputProps) {
  const { t } = useI18n();
  const phone = useIsMobile();
  const [showPayment, setShowPayment] = useState(false);
  const [showIdentities, setShowIdentities] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [showPanel, setShowPanel] = useState(false);
  const [showCamera, setShowCamera] = useState(false);
  const plusRef = useRef<HTMLButtonElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLDivElement>(null);
  const panelButtonRef = useRef<HTMLButtonElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mediaInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(() => draftId ? getSessionDraft(draftId) : "");
  const [toast, setToast] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const caretRef = useRef<number | null>(null);
  const [canRecord] = useState(canRecordVoice);
  const sharedIdentities = useSharedIdentityCount(identities?.peerKey);
  const hasCamera = useHasCamera();

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  useEffect(() => {
    if (draftId) setSessionDraft(draftId, text);
    const input=textareaRef.current;
    if(input && text) { input.style.height="auto"; input.style.height=`${Math.min(input.scrollHeight,120)}px`; }
  }, [draftId,text]);

  // An emoji goes in where the caret was; the caret stays after it.
  useLayoutEffect(() => {
    const input = textareaRef.current, at = caretRef.current;
    if (input && at !== null) { caretRef.current = null; input.setSelectionRange(at, at); }
  }, [text]);

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

  const handleEmojiSelect = (emoji: string) => {
    const input = textareaRef.current;
    const start = input?.selectionStart ?? text.length, end = input?.selectionEnd ?? text.length;
    const next = text.slice(0, start) + emoji + text.slice(end);
    if (next.length > Math.max(maxLength, 16_384)) return;
    caretRef.current = start + emoji.length;
    setText(next);
    // On a phone the keyboard would cover the panel: the field takes the focus only on a wide screen.
    if (!phone) input?.focus({ preventScroll: true });
  };

  const handleGifSelect = async (url: string) => {
    const err = await onSend(url);
    if (err) showToast(err);
    setShowPanel(false);
    if (!phone) textareaRef.current?.focus();
  };

  /** Whatever the composer has open over it. */
  const closeAll = () => {
    setShowMenu(false);
    setShowPanel(false);
    setShowPayment(false);
    setShowIdentities(false);
  };

  const sendFiles = async (files: FileList | null, input: HTMLInputElement) => {
    const chosen = [...(files ?? [])];
    input.value = "";
    if (!onSendFile || disabled || fileUnavailable) return;
    for (const file of chosen) {
      const err = await onSendFile(file);
      if (err) { showToast(err); return; }
    }
  };

  const actions: ComposerAction[] = [];
  // A chat that chooses its own ways of paying always reaches them, to turn one on again: the reason is a hint then.
  const paymentsConfigurable = !paymentComposer && !!payments?.onSaveMethods;
  if (payments || paymentComposer) actions.push({ id: "payment", label: t("composer.payment"), icon: <PaymentGlyph />, testId: "payment-button",
    unavailable: paymentsConfigurable ? undefined : paymentsUnavailable, hint: paymentsConfigurable ? paymentsUnavailable : undefined, onSelect: () => setShowPayment(true) });
  if (identities) actions.push({ id: "identity", label: t("composer.identity"), icon: <IdentityGlyph />, testId: "composer-identities-button",
    hint: sharedIdentities ? t("composer.identityShared", { count: String(sharedIdentities) }) : undefined, data: { "data-count": sharedIdentities },
    onSelect: () => setShowIdentities(true) });
  if (services) actions.push({ id: "services", label: t("composer.services"), icon: <ServicesGlyph />, testId: "composer-services",
    unavailable: services.unavailable, hint: services.hint,
    // The chat's dialog gives the focus back to what had it when it opened: the +, as Escape from the menu does.
    onSelect: () => { plusRef.current?.focus({ preventScroll: true }); services.onOpen(); } });
  if (onSendFile) {
    actions.push({ id: "document", label: t("composer.document"), icon: <DocumentGlyph />, testId: "composer-file", unavailable: fileUnavailable,
      onSelect: () => fileInputRef.current?.click() });
    actions.push({ id: "media", label: t("composer.media"), icon: <MediaGlyph />, testId: "composer-media", unavailable: fileUnavailable,
      onSelect: () => mediaInputRef.current?.click() });
    if (hasCamera) actions.push({ id: "camera", label: t("composer.camera"), icon: <CameraGlyph />, testId: "composer-camera", unavailable: fileUnavailable,
      onSelect: () => cameraByFileInput() ? cameraInputRef.current?.click() : setShowCamera(true) });
  }

  const bytes = maxBytes || softBytes ? new TextEncoder().encode(text.trim()).length : 0;
  const remaining = maxBytes ? maxBytes - bytes : maxLength - text.length;
  const overSoft = !!softBytes && bytes > softBytes;

  return (
    <div ref={composerRef} data-composer className="@container/composer bg-panel-header px-3 max-md:px-2 py-2 composer-safe shrink-0 relative">
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
      <div className="composer-row flex items-end gap-2 relative">
        {/* One rounded field: the +, the emoji/GIF panel's smiley and the message. */}
        <div ref={fieldRef} className="composer-field" data-disabled={disabled || undefined}>
          <ComposerMenu actions={actions} open={showMenu} disabled={disabled} buttonRef={plusRef}
            onOpenChange={(open) => { if (open) closeAll(); setShowMenu(open); }} />
          <button
            ref={panelButtonRef}
            type="button"
            data-testid="composer-expressions"
            aria-expanded={showPanel}
            aria-haspopup="dialog"
            onClick={() => { const open = !showPanel; closeAll(); setShowPanel(open); }}
            disabled={disabled}
            className={`composer-icon-button ${showPanel ? "composer-icon-button-on" : ""}`}
            aria-label={t("composer.expressions")}
            title={t("composer.expressions")}
          >
            <SmileIcon size={24} />
          </button>

          <div className="flex-1 min-w-0 relative flex items-center self-stretch">
            <textarea
              ref={textareaRef}
              value={text}
              onChange={handleInput}
              onKeyDown={handleKeyDown}
              onFocus={() => { setShowMenu(false); setShowIdentities(false); if (phone) setShowPanel(false); }}
              placeholder={disabled ? disabledPlaceholder : "Message…"}
              disabled={disabled}
              rows={1}
              className="composer-textarea"
            />
            {softBytes && !maxBytes && bytes > softBytes - 60 && (
              <span data-testid="dht-byte-count" title={overSoft ? `Over the ${softBytes} bytes the DHT carries: it is sent when you are live` : undefined}
                className={`absolute right-2.5 bottom-1 text-[10px] ${overSoft ? "text-amber-500" : "text-text-muted"}`}>
                {bytes} / {softBytes} B
              </span>
            )}
            {!(softBytes && !maxBytes) && remaining < 100 && (
              <span
                className={`absolute right-2.5 bottom-1 text-[10px] ${remaining < 50 ? "text-danger" : "text-text-muted"}`}
              >
                {remaining}{maxBytes ? " B" : ""}
              </span>
            )}
          </div>
        </div>

        {/* Send button; the mic while there is nothing to send, as in WhatsApp */}
        {onSendFile && canRecord && !text.trim() ? (
          <VoiceRecorderButton
            onSend={(file, voice) => onSendFile(file, voice)}
            unavailable={fileUnavailable}
            disabled={disabled}
            onError={showToast}
            onActiveChange={(active) => { if (active) closeAll(); }}
          />
        ) : <button
          aria-label="Send message"
          onClick={handleSubmit}
          disabled={disabled || !text.trim()}
          className="composer-send w-11 h-11 max-md:w-12 max-md:h-12 flex items-center justify-center bg-accent rounded-full text-on-accent hover:bg-accent-hover transition-colors disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer shrink-0"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
          </svg>
        </button>}

        {/* What the + opens */}
        {showPayment && paymentComposer && !paymentsUnavailable && !disabled && paymentComposer(() => setShowPayment(false))}
        {showPayment && !paymentComposer && payments && (paymentsConfigurable || !paymentsUnavailable) && !disabled && (
          <PaymentComposer
            reviewContext={payments.reviewContext}
            balance={payments.balance}
            contact={payments.contact}
            onSend={payments.onSend}
            onRequest={payments.onRequest}
            sendUnavailable={payments.sendUnavailable}
            payUnavailable={paymentsUnavailable}
            onSaveMethods={payments.onSaveMethods}
            onClose={() => setShowPayment(false)}
          />
        )}

        {showIdentities && identities && (
          <ComposerIdentityPicker peerKey={identities.peerKey} contact={identities.contact} anchorRef={plusRef}
            onClose={() => setShowIdentities(false)} />
        )}
      </div>

      {onSendFile && <>
        <input ref={fileInputRef} type="file" className="hidden" data-testid="file-input" disabled={disabled || !!fileUnavailable}
          onChange={(e) => void sendFiles(e.target.files, e.target)} />
        <input ref={mediaInputRef} type="file" accept="image/*,video/*" multiple className="hidden" data-testid="media-input" disabled={disabled || !!fileUnavailable}
          onChange={(e) => void sendFiles(e.target.files, e.target)} />
        <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" className="hidden" data-testid="camera-input" disabled={disabled || !!fileUnavailable}
          onChange={(e) => void sendFiles(e.target.files, e.target)} />
      </>}

      {showPanel && (
        <ExpressionPanel
          boundsRef={composerRef}
          dismissRef={fieldRef}
          onEmoji={handleEmojiSelect}
          onGif={handleGifSelect}
          onClose={() => {
            setShowPanel(false);
            const at = document.activeElement;
            if (!phone && (!at || at === document.body || at.closest("[data-testid='expression-panel']"))) textareaRef.current?.focus();
          }}
        />
      )}
      {showCamera && onSendFile && (
        <CameraCapture onClose={() => setShowCamera(false)} onSend={(file) => {
          setShowCamera(false);
          void onSendFile(file).then((err) => { if (err) showToast(err); });
        }} />
      )}
    </div>
  );
}
