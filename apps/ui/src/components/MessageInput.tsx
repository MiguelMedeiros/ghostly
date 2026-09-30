import { getSessionDraft, setSessionDraft } from "../lib/storage";
import { useState, useRef, useEffect, useLayoutEffect, useCallback, type ClipboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { PaymentComposer } from "./PaymentComposer";
import { ComposerIdentityPicker, useSharedIdentityCount } from "./identities/ComposerIdentities";
import { VoiceRecorderButton } from "./voice/VoiceRecorderButton";
import { canRecordVoice } from "../lib/voiceRecorder";
import type { LinkPreview, TypingKind, VoiceMeta } from "@ghostly/core";
import { useI18n } from "../contexts/I18nContext";
import { useIsLocked } from "../contexts/LockScreenContext";
import { useIsMobile } from "../hooks/useIsMobile";
import { ComposerMenu, type ComposerAction } from "./composer/ComposerMenu";
import { SecretGuardDialog } from "./SecretGuardDialog";
import { findSecret, type SecretFinding } from "../lib/parse/secrets";
import { ExpressionPanel } from "./composer/ExpressionPanel";
import { CameraCapture, cameraByFileInput, useHasCamera } from "./composer/CameraCapture";
import { CameraGlyph, DocumentGlyph, IdentityGlyph, MediaGlyph, PaymentGlyph, ServicesGlyph, SmileIcon } from "./composer/icons";
import type { ComposerServices } from "./composer/servicesRow";
import { useMentionPicker, type ComposerMentions } from "./composer/MentionPicker";
import type { GroupMention } from "@ghostly/core";
import { LinkPreviewDraftCard } from "./composer/LinkPreviewDraft";
import { EditBar, ReplyBar } from "./chat/ReplyQuote";
import { useLinkPreviewDraft } from "../hooks/useLinkPreviewDraft";
import { AttachmentSheet } from "./composer/AttachmentSheet";
import { dragHasFiles, droppedFiles, pastedFiles, pasteShowsNothing, platformPastedFiles } from "../lib/pastedFiles";
import { onShareChange, peekShareFor, shareText, takeShareFor } from "../lib/incomingShare";
import { fitFieldHeight } from "./composer/fieldHeight";
import { useComposition } from "../hooks/useComposition";
import "./composer/composer.css";
import { touchOnly } from "../lib/touchOnly";
import { formatAmount } from "../lib/amount";

interface MessageInputProps {
  draftId?: string;
  /**
   * `mentions`: in a group, the places of the text that name members (see `mentions` below). `extra.preview`: in a
   * paired chat, the link preview shown in the composer when it was sent (`linkPreviews`).
   */
  onSend: (text: string, mentions?: GroupMention[], extra?: { preview?: LinkPreview }) => Promise<string | null>;
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
  /** `paymentsUnavailable` is about the contact's side: the payment cards say "Not accepted" rather than "Off here". */
  paymentsUnavailableContact?: boolean;
  /** With `voice`, the file is a voice message recorded here (the mic replaces send while the text is empty). */
  onSendFile?: (file: File, voice?: VoiceMeta) => Promise<string | null>;
  /** Present when the platform has a wallet. */
  payments?: {
    reviewContext?: {wallet:import("../lib/platform").WalletPlatform;peer:string;linkId:string};
    balance: number;
    /** Who the chat is with, as the chat shows them. */
    contact?: string;
    /** `network`: the card's; a card of one network never pays the other's. */
    onSend: (amount: number, memo: string, network?: import("../lib/platform").WalletNetwork) => Promise<string | null>;
    onRequest: (amount: number, memo: string, method?: "cashu" | "arkade" | "usdt" | "bark" | "bitcoin" | "fedimint" | "spark", rail?: import("./walletCardTypes").ChatRail, network?: import("../lib/platform").WalletNetwork) => Promise<string | null>;
    /** Why paying is not possible now (a request still is): shown on the Pay side. */
    sendUnavailable?: string;
    /** Saves which ways of paying this chat accepts, from the composer's Accept side. */
    onSaveMethods?: (accepts: import("../lib/chatPayments").ChatAccepts) => Promise<void>;
  };
  /** A composer of its own for payments instead of the chat's (a group chooses whom to pay first). */
  paymentComposer?: (close: () => void) => ReactNode;
  /** A paired chat: which of this profile's identities its contact sees, from the + menu. */
  /** `open`: the picker opens on this identity of mine (a share of mine tapped in the timeline); a new `at` opens it again. */
  identities?: { peerKey: string; contact: string; open?: { id: string; at: number } };
  /** A 1:1 chat's shared services, from the + menu: which of yours the contact can open, and theirs (`composerServices`). */
  services?: ComposerServices;
  /** Who reads what is sent here, for the secret guard's Cashu question (a group's name); the contact otherwise. */
  recipient?: string;
  /** A group's members: "@" opens a picker of them, and a choice names the member by key. */
  mentions?: ComposerMentions;
  /** A link in the draft gets a preview made here, sent with the message (a paired chat, with the setting on). */
  linkPreviews?: boolean;
  /**
   * Typing (a paired chat): true on a keystroke that leaves text, false when the text is cleared or sent; with
   * `"recording"` while a voice note is recorded, false when it is sent or thrown away.
   */
  onTyping?: (typing: boolean, kind?: TypingKind) => void;
  /**
   * The message being answered (WISP 400 § Replies), shown above the field with ✕; Escape cancels too. The page keeps
   * it and sends it with the text. A new `key` (another message) brings the focus to the field.
   */
  reply?: { key: string; name?: string; snippet: string; mine: boolean; member?: string; onCancel: () => void };
  /**
   * A message of mine being edited (WISP 400 § Edits): its text fills the field, the draft waits and comes back after.
   * Enter saves through `onSave`; ✕ or Escape leaves it. Either way `onClose` ends it. A new `key` edits another one.
   */
  edit?: { key: string; text: string; snippet: string; onSave: (text: string, extra?: { preview?: LinkPreview; mentions?: GroupMention[] }) => Promise<string | null>; onClose: () => void };
  /** ↑ in an empty field: edit my last message, as in Slack and Telegram. */
  onEditLast?: () => void;
}

/** A message sent from the field, waiting for the one before it to go. */
interface Outgoing { words: string; named: GroupMention[]; preview?: LinkPreview }

const DEFAULT_MAX = 500;
const TOAST_DURATION = 5_000;

/**
 * The chat's composer, laid out as WhatsApp's: [+] [emoji/GIF] [message] in one rounded field, and the mic (send
 * once there is text) beside it. The + opens what else can go into the chat (a payment, an identity, shared services, a
 * document, photos, the camera); the smiley opens one panel with emoji and GIFs.
 */
export function MessageInput({
  draftId,
  onSend,
  disabled,
  disabledPlaceholder,
  maxLength = DEFAULT_MAX,
  maxBytes,
  softBytes,
  onSendFile,
  payments,
  paymentComposer,
  identities,
  services,
  mentions,
  fileUnavailable,
  paymentsUnavailable,
  paymentsUnavailableContact,
  recipient,
  linkPreviews = false,
  onTyping,
  reply,
  edit,
  onEditLast,
}: MessageInputProps) {
  const { t } = useI18n();
  const phone = useIsMobile();
  const locked = useIsLocked();
  const [showPayment, setShowPayment] = useState(false);
  const [showIdentities, setShowIdentities] = useState(false);
  /** The picker closed because an identity was shared: the keys go back to the message, not to the +. */
  const sharedIdentity = useRef(false);
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
  /** `caption`: the guard asks about a pasted file's caption, not the draft. */
  const [secret, setSecret] = useState<{ finding: SecretFinding; caption?: string } | null>(null);
  /** Files pasted or dropped here, waiting on the sheet for Send. */
  const [attached, setAttached] = useState<File[] | null>(null);
  const [dragging, setDragging] = useState<HTMLElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const caretRef = useRef<number | null>(null);
  /**
   * Each Enter is a message of its own: its words leave the field at once and wait here, and they go one at a time, in
   * the order they were sent. A double press finds the field empty and sends nothing more.
   */
  const outbox = useRef<Outgoing[]>([]);
  const sending = useRef(false);
  /** An edit being saved: Enter again meanwhile saves nothing more. */
  const saving = useRef(false);
  const onSendRef = useRef(onSend); onSendRef.current = onSend;
  const draftIdRef = useRef(draftId); draftIdRef.current = draftId;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const composition = useComposition();
  const [canRecord] = useState(canRecordVoice);
  /** A voice message being recorded: the mic stays (and its recording with it) even if an edit or a reply fills the field. */
  const [recording, setRecording] = useState(false);
  const sharedIdentities = useSharedIdentityCount(identities?.peerKey);
  const hasCamera = useHasCamera();
  const picker = useMentionPicker({ mentions, text, setText, textareaRef, caretRef });
  const linkPreview = useLinkPreviewDraft(text, linkPreviews && !disabled);

  // Ready to type when the chat opens, where that costs nothing: on a touch screen the keyboard would come up over
  // the chat before the person asked for it, so there the field waits for a tap (apps/ui/src/lib/touchOnly.ts).
  useEffect(() => {
    if (!touchOnly()) textareaRef.current?.focus();
  }, []);

  // Disabled for a moment under the caret (a 1:1 chat's send under way): the browser takes the focus from a disabled
  // field and never gives it back, so the next message went nowhere. It comes back unless something else took it.
  const focusedWhenDisabled = useRef(false);
  useLayoutEffect(() => {
    const input = textareaRef.current;
    if (disabled) { focusedWhenDisabled.current = !!input && document.activeElement === input; return; }
    if (!focusedWhenDisabled.current) return;
    focusedWhenDisabled.current = false;
    const active = document.activeElement;
    if (input && (!active || active === document.body || active === input)) input.focus({ preventScroll: true });
  }, [disabled]);

  // Answering a message: the words go in the field at once, as in WhatsApp.
  const replyKey = reply?.key;
  useEffect(() => {
    if (replyKey) textareaRef.current?.focus({ preventScroll: true });
  }, [replyKey]);

  // Editing: the message's words in the field, the caret at their end; the draft is kept aside until the edit ends.
  const editKey = edit?.key, editText = edit?.text;
  const draftAside = useRef<string | null>(null);
  useEffect(() => {
    if (!editKey || editText === undefined) return;
    if (draftAside.current === null) draftAside.current = textareaRef.current?.value ?? "";
    caretRef.current = editText.length;
    setText(editText);
    textareaRef.current?.focus({ preventScroll: true });
  }, [editKey, editText]);
  const endEdit = () => {
    const draft = draftAside.current ?? "";
    draftAside.current = null;
    setText(draft);
    edit?.onClose();
  };

  const editing = !!edit;
  useEffect(() => {
    // A draft holding a seed or a key is not written to storage; ecash is, since the draft may be its only copy.
    // Not while editing: the draft is the one kept aside.
    if (draftId && !editing) { const found = findSecret(text); setSessionDraft(draftId, found && found.kind !== "cashu" ? "" : text); }
    // Text put in by the app (an emoji, an edit, a share): the field fits it. A keystroke was fitted already.
    // Emptied by the app (an edit ended, saved or not) after it grew: back to one line.
    const input=textareaRef.current;
    if(input && (text || input.style.height)) fitFieldHeight(input);
  }, [draftId,text,editing]);

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

  /**
   * What could not go comes back to the field, before what is typed there now: the failed words, then those that waited
   * behind them. Nothing is dropped. With the chat left meanwhile, it is its draft that gets them.
   */
  const giveBack = (words: string[]) => {
    const back = (now: string) => [...words, now].filter((part) => part.trim()).join("\n");
    if (mounted.current) { setText(back); return; }
    const id = draftIdRef.current;
    if (id) setSessionDraft(id, back(getSessionDraft(id)));
  };

  /**
   * The messages waiting, one after the other. It goes on after the chat is left (the component is keyed by chat), so
   * what was sent is not lost; `onSend` is the latest one given, since this loop outlives the render that started it.
   * The first that fails stops the rest: they come back to the field with it, in order, rather than go out of order.
   */
  const drain = async () => {
    if (sending.current) return;
    sending.current = true;
    try {
      for (let next = outbox.current[0]; next; next = outbox.current[0]) {
        let err: string | null;
        try {
          const send = onSendRef.current;
          err = await (next.named.length ? send(next.words, next.named) : next.preview ? send(next.words, undefined, { preview: next.preview }) : send(next.words));
        } catch (e) {
          err = e instanceof Error ? e.message : String(e);
        }
        if (err) {
          const failed = outbox.current.splice(0).map((o) => o.words);
          if (mounted.current) showToast(err);
          giveBack(failed);
          return;
        }
        outbox.current.shift();
      }
    } finally {
      sending.current = false;
    }
  };

  /** `confirmed` once the secret guard was answered Send; until then text that looks like a secret asks first. */
  const handleSubmit = async (confirmed = false) => {
    if (!text.trim() || disabled) return;
    const bytes = new TextEncoder().encode(text.trim()).length;
    if (maxBytes && bytes > maxBytes) { showToast(t("composer.dhtTooLong", { bytes, max: maxBytes })); return; }
    const found = confirmed ? null : findSecret(text);
    if (found) { setSecret({ finding: found }); return; }
    if (edit) {
      if (saving.current) return;
      saving.current = true;
      try {
        // In a group, members named with @ while editing go with it; those the message named already stay by themselves.
        const named = picker.compose(text);
        const extra = { ...(linkPreview.preview && { preview: linkPreview.preview }), ...(named.length && { mentions: named }) };
        const err = await edit.onSave(text, Object.keys(extra).length ? extra : undefined);
        if (err) showToast(err); else { picker.reset(); linkPreview.reset(); endEdit(); }
      } finally {
        saving.current = false;
      }
      return;
    }
    // The words leave the field now, with what goes with them (the members named, the preview), and wait their turn.
    outbox.current.push({ words: text, named: picker.compose(text), preview: linkPreview.preview ?? undefined });
    picker.reset();
    linkPreview.reset();
    setText("");
    onTyping?.(false);
    if (draftId) setSessionDraft(draftId, "");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    await drain();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Keys an input method is using (Enter confirming a candidate, the arrows, Escape) are its own, not the composer's.
    if (composition.composing(e)) return;
    if (picker.onKeyDown(e)) return;
    // Whatever the composer has open over it closes first; then Escape lets go of the message being answered.
    const nothingOpen = !showPanel && !showMenu && !showPayment && !showIdentities;
    if (e.key === "Escape" && edit && nothingOpen) { e.preventDefault(); e.stopPropagation(); endEdit(); return; }
    if (e.key === "Escape" && reply && nothingOpen) { e.preventDefault(); e.stopPropagation(); reply.onCancel(); return; }
    if (e.key === "ArrowUp" && onEditLast && !edit && !text && nothingOpen && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      onEditLast();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    if (value.length <= Math.max(maxLength, 16_384)) {
      setText(value);
      // Editing a sent message is not writing a new one.
      if (!edit) onTyping?.(value.trim() !== "");
      picker.onCaret();
    } else if (value.length - text.length > 1) {
      showToast(
        maxLength > DEFAULT_MAX
          ? t("composer.tooLong", { count: formatAmount(value.length, t.language), max: formatAmount(maxLength, t.language) })
          : t("composer.tooLongDht"),
      );
    }
    if (textareaRef.current) fitFieldHeight(textareaRef.current);
  };

  const handleEmojiSelect = (emoji: string) => {
    const input = textareaRef.current;
    const start = input?.selectionStart ?? text.length, end = input?.selectionEnd ?? text.length;
    const next = text.slice(0, start) + emoji + text.slice(end);
    if (next.length > Math.max(maxLength, 16_384)) return;
    caretRef.current = start + emoji.length;
    setText(next);
    onTyping?.(true);
    // On a phone the keyboard would cover the panel: the field takes the focus only on a wide screen.
    if (!phone) input?.focus({ preventScroll: true });
  };

  const handleGifSelect = async (url: string) => {
    const err = await onSend(url);
    if (err) showToast(err);
    setShowPanel(false);
    if (!phone) textareaRef.current?.focus();
  };

  // A share of mine tapped in the chat's timeline: the picker, on that card.
  const openOn = identities?.open;
  useEffect(() => {
    if (!openOn) return;
    setShowMenu(false);
    setShowIdentities(true);
  }, [openOn]);

  // After the picker's own cleanup (which gives the + the focus): on a phone the + keeps it, no keyboard popping up.
  useEffect(() => {
    if (showIdentities || !sharedIdentity.current) return;
    sharedIdentity.current = false;
    if (!phone) textareaRef.current?.focus({ preventScroll: true });
  }, [showIdentities, phone]);

  /** Whatever the composer has open over it. */
  const closeAll = () => {
    setShowMenu(false);
    setShowPanel(false);
    setShowPayment(false);
    setShowIdentities(false);
  };

  /** One after the other, as + → Document sends them; the first that cannot go stops the rest. False then. */
  const sendChosen = async (chosen: File[]): Promise<boolean> => {
    if (!onSendFile || disabled || fileUnavailable) return false;
    for (const file of chosen) {
      const err = await onSendFile(file);
      if (err) { showToast(err); return false; }
    }
    return true;
  };

  const sendFiles = (files: FileList | null, input: HTMLInputElement) => {
    const chosen = [...(files ?? [])];
    input.value = "";
    void sendChosen(chosen);
  };

  /** Files pasted or dropped: to the sheet, or the reason they cannot go. False where files have no place here. */
  const offerFiles = (files: File[]): boolean => {
    // An edit is text only: files wait until it ends.
    if (!onSendFile || disabled || !files.length || edit) return false;
    if (fileUnavailable) { showToast(fileUnavailable); return true; }
    closeAll();
    setAttached((was) => [...(was ?? []), ...files]);
    return true;
  };
  const offerRef = useRef(offerFiles); offerRef.current = offerFiles;

  /**
   * A paste's files to the sheet. True when the paste was taken; false leaves it to the field: no files, or a rich
   * copy, is text as it always was. A paste that showed nothing at all asks the platform (a webview may keep copied
   * files or a picture from the page).
   */
  const takePaste = (data: DataTransfer | null): boolean => {
    if (locked || edit) return false;
    const files = pastedFiles(data);
    if (files) return offerFiles(files);
    if (!onSendFile || disabled || !pasteShowsNothing(data)) return false;
    const reading = platformPastedFiles();
    if (!reading) return false;
    reading.then((found) => { if (found.length) offerRef.current(found); }, (error: unknown) => showToast(error instanceof Error ? error.message : String(error)));
    return true;
  };
  const takeRef = useRef(takePaste); takeRef.current = takePaste;

  const handlePaste = (e: ClipboardEvent) => {
    if (takePaste(e.clipboardData)) e.preventDefault();
  };

  /** A caption goes as a message of its own after the files, through the same checks as the draft. */
  const sendCaption = async (caption: string, confirmed = false) => {
    if (!caption) return;
    const bytes = new TextEncoder().encode(caption).length;
    if (maxBytes && bytes > maxBytes) { showToast(t("composer.captionTooLong", { bytes, max: maxBytes })); return; }
    const found = confirmed ? null : findSecret(caption);
    if (found) { setSecret({ finding: found, caption }); return; }
    const err = await onSend(caption);
    if (err) showToast(err);
  };

  const sendAttached = async (caption: string) => {
    const files = attached ?? [];
    setAttached(null);
    if (await sendChosen(files)) await sendCaption(caption);
  };

  // Behind the lock screen nothing is pasted or dropped in (the composer stays mounted under it).
  const canAttach = !!onSendFile && !disabled && !locked;
  // Something shared into the app from another one, sent to this chat from the "Share to…" picker: its text into
  // the draft, its files onto the sheet a paste opens. Files wait until they can go (the composer unlocked).
  useEffect(() => {
    if (!draftId) return;
    const take = () => {
      const waiting = peekShareFor(draftId);
      if (!waiting || (waiting.files.length && !canAttach && !fileUnavailable)) return;
      const share = takeShareFor(draftId)!;
      const shared = shareText(share);
      if (shared) setText((was) => (was.trim() ? `${was}\n${shared}` : shared));
      if (share.files.length) offerRef.current(share.files);
      else if (!touchOnly()) textareaRef.current?.focus();
    };
    take();
    return onShareChange(take);
  }, [draftId, canAttach, fileUnavailable]);

  // A paste where no field has the focus (the chat's messages clicked last) still brings its files here.
  useEffect(() => {
    if (!canAttach) return;
    const paste = (e: globalThis.ClipboardEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      if (e.defaultPrevented || target?.closest("input, textarea, select, [contenteditable=''], [contenteditable='true'], [role='dialog']")) return;
      if (takeRef.current(e.clipboardData)) e.preventDefault();
    };
    document.addEventListener("paste", paste);
    return () => document.removeEventListener("paste", paste);
  }, [canAttach]);

  // Files dragged over the chat (its column, where the page marks one): a veil says they can be dropped.
  useEffect(() => {
    const zone = composerRef.current?.closest<HTMLElement>("[data-file-drop]") ?? composerRef.current;
    if (!canAttach || !zone) return;
    let depth = 0;
    const enter = (e: DragEvent) => {
      if (!dragHasFiles(e.dataTransfer)) return;
      e.preventDefault();
      depth += 1;
      setDragging(zone);
    };
    const over = (e: DragEvent) => {
      if (!dragHasFiles(e.dataTransfer)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const done = () => { depth = 0; setDragging(null); };
    const leave = (e: DragEvent) => {
      depth = Math.max(0, depth - 1);
      // Out of the column (where the browser says where to): gone, even if an enter went uncounted.
      const to = e.relatedTarget;
      if (!depth || (to instanceof Node && !zone.contains(to))) done();
    };
    const drop = (e: DragEvent) => {
      done();
      if (!dragHasFiles(e.dataTransfer)) return;
      e.preventDefault();
      offerRef.current(droppedFiles(e.dataTransfer));
    };
    zone.addEventListener("dragenter", enter);
    zone.addEventListener("dragover", over);
    zone.addEventListener("dragleave", leave);
    zone.addEventListener("drop", drop);
    // A drag that ends anywhere else (dropped outside, Escape) takes the veil with it.
    window.addEventListener("drop", done);
    window.addEventListener("dragend", done);
    return () => {
      zone.removeEventListener("dragenter", enter);
      zone.removeEventListener("dragover", over);
      zone.removeEventListener("dragleave", leave);
      zone.removeEventListener("drop", drop);
      window.removeEventListener("drop", done);
      window.removeEventListener("dragend", done);
      setDragging(null);
    };
  }, [canAttach]);

  const actions: ComposerAction[] = [];
  // A chat that chooses its own ways of paying always reaches them, to turn one on again: the reason is a hint then.
  const paymentsConfigurable = !paymentComposer && !!payments?.onSaveMethods;
  if (payments || paymentComposer) actions.push({ id: "payment", label: t("composer.payment"), icon: <PaymentGlyph />, testId: "payment-button",
    unavailable: paymentsConfigurable ? undefined : paymentsUnavailable, hint: paymentsConfigurable ? paymentsUnavailable : undefined, onSelect: () => setShowPayment(true) });
  if (identities) actions.push({ id: "identity", label: t("composer.identity"), icon: <IdentityGlyph />, testId: "composer-identities-button",
    hint: sharedIdentities ? t("composer.identityShared", { count: String(sharedIdentities) }) : undefined, data: { "data-count": sharedIdentities },
    onSelect: () => setShowIdentities(true) });
  if (services) actions.push({ id: "services", label: t("composer.services"), icon: <ServicesGlyph />, testId: "composer-services",
    unavailable: services.unavailable, hint: services.hint, oneLine: true,
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
              aria-label={t("common.close")}
              className="text-text-muted hover:text-text-primary transition-colors cursor-pointer bg-transparent border-none p-0 text-lg leading-none shrink-0"
            >
              &times;
            </button>
          </div>
        </div>
      )}
      {edit && <EditBar snippet={edit.snippet} onCancel={() => { endEdit(); textareaRef.current?.focus({ preventScroll: true }); }} />}
      {reply && !edit && <ReplyBar name={reply.name} snippet={reply.snippet} mine={reply.mine} member={reply.member} onCancel={() => { reply.onCancel(); textareaRef.current?.focus({ preventScroll: true }); }} />}
      {linkPreview.draft && <LinkPreviewDraftCard draft={linkPreview.draft} onRemove={linkPreview.remove} />}
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
              onPaste={handlePaste}
              onSelect={picker.onCaret}
              {...picker.inputProps}
              {...composition.inputProps}
              onFocus={() => { setShowMenu(false); setShowIdentities(false); if (phone) setShowPanel(false); }}
              placeholder={disabled ? disabledPlaceholder ?? t("composer.placeholder") : t("composer.placeholder")}
              disabled={disabled}
              rows={1}
              className="composer-textarea"
            />
            {softBytes && !maxBytes && bytes > softBytes - 60 && (
              <span data-testid="dht-byte-count" title={overSoft ? t("composer.overSoft", { bytes: softBytes }) : undefined}
                className={`absolute end-2.5 bottom-1 text-[10px] ${overSoft ? "text-amber-500" : "text-text-muted"}`}>
                {bytes} / {softBytes} B
              </span>
            )}
            {!(softBytes && !maxBytes) && remaining < 100 && (
              <span
                className={`absolute end-2.5 bottom-1 text-[10px] ${remaining < 50 ? "text-danger" : "text-text-muted"}`}
              >
                {remaining}{maxBytes ? " B" : ""}
              </span>
            )}
          </div>
        </div>

        {/* Send button; the mic while there is nothing to send, as in WhatsApp */}
        {onSendFile && canRecord && (recording || !text.trim()) ? (
          <VoiceRecorderButton
            onSend={(file, voice) => onSendFile(file, voice)}
            unavailable={fileUnavailable}
            disabled={disabled}
            onError={showToast}
            // Recording: the composer's pickers close, and the contact sees "recording audio…" until it ends.
            onActiveChange={(active) => { setRecording(active); if (active) closeAll(); onTyping?.(active, "recording"); }}
          />
        ) : <button
          aria-label={t("composer.sendMessage")}
          // The field keeps the focus: a tap on Send would take it (and on a phone close the keyboard) mid-conversation.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => handleSubmit()}
          disabled={disabled || !text.trim()}
          className="composer-send w-11 h-11 max-md:w-12 max-md:h-12 flex items-center justify-center bg-accent rounded-full text-on-accent hover:bg-accent-hover transition-colors disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer shrink-0"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
          </svg>
        </button>}

        {picker.element}

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
            payUnavailableContact={paymentsUnavailableContact}
            onSaveMethods={payments.onSaveMethods}
            onClose={() => setShowPayment(false)}
            // Sent or requested: back to the chat, where its bubble shows how it goes, and to writing.
            onDone={() => { setShowPayment(false); if (!touchOnly()) textareaRef.current?.focus({ preventScroll: true }); }}
          />
        )}

        {showIdentities && identities && (
          <ComposerIdentityPicker key={identities.open?.at} peerKey={identities.peerKey} contact={identities.contact} initial={identities.open?.id} anchorRef={plusRef}
            onClose={() => setShowIdentities(false)}
            onShared={() => { sharedIdentity.current = true; setShowIdentities(false); }} />
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
      {secret && (
        <SecretGuardDialog finding={secret.finding} recipient={recipient ?? payments?.contact ?? identities?.contact}
          onCancel={() => setSecret(null)} onConfirm={() => {
            setSecret(null);
            if (secret.caption !== undefined) void sendCaption(secret.caption, true);
            else void handleSubmit(true);
          }} />
      )}
      {attached && !locked && (
        <AttachmentSheet files={attached}
          onAdd={(more) => setAttached((was) => [...(was ?? []), ...more])}
          onRemove={(index) => setAttached((was) => was && was.length > 1 ? was.filter((_, i) => i !== index) : null)}
          onCancel={() => setAttached(null)}
          onSend={(caption) => void sendAttached(caption)} />
      )}
      {dragging && createPortal(
        <div data-testid="file-drop-overlay" aria-hidden="true"
          className="absolute inset-0 z-40 pointer-events-none flex items-center justify-center bg-chat-bg/80 border-2 border-dashed border-accent rounded-lg m-2 animate-fade-in">
          <p className="flex items-center gap-2 text-sm font-medium text-text-primary bg-panel-header rounded-full px-4 py-2 shadow-lg">
            <DocumentGlyph />{t("composer.dropFiles")}
          </p>
        </div>, dragging)}
      {showCamera && onSendFile && (
        <CameraCapture onClose={() => setShowCamera(false)} onSend={(file) => {
          setShowCamera(false);
          void onSendFile(file).then((err) => { if (err) showToast(err); });
        }} />
      )}
    </div>
  );
}
