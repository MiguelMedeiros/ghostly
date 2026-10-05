import { useBackdropDismiss } from "../hooks/useDismiss";
import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import jsQR from "jsqr";
import { decodeCommunityLink, decodeGroupEntryLink, readDeviceInvite } from "@ghostly/core";
import { enrollErrorKey, failureKey, offerDeviceLink } from "../lib/devices";
import { INVITE_REFUSAL_MESSAGE, classifyInvite, readInvite } from "../lib/url";
import { showJoinNotice } from "../lib/joinNotice";
import { pasteShortcut, readClipboardText } from "../lib/clipboard";
import { dragHasFiles, droppedFiles, pastedFiles } from "../lib/pastedFiles";
import { touchOnly } from "../lib/touchOnly";
import { useI18n } from "../contexts/I18nContext";
import type { SessionKeys } from "../lib/storage";
import { errorText } from "../lib/errorText";

/**
 * Scanned data is only parsed as an invite; never opened as a URL or executed. A picture pasted or dropped on the
 * dialog (a screenshot of an invite's QR) is read as "Open image" reads one. A group's link
 * (`group1/…`) goes to `onJoinGroup`, which the dialog waits for, so a refusal is shown here.
 *
 * An invite this profile already has a chat for makes no second chat (WISP 801 Q9): one it made itself
 * is refused here, with the way to that chat (`onOpenChat`); one it already joined by opens that chat.
 */
/**
 * `autoScan`: the camera starts at once (the installed app's "Scan invite" shortcut). `onDevice`: the dialog reads the
 * code that adds this device to a profile (WISP 06) instead of a chat invite, and waits for it to be taken.
 */
export function JoinDialog({ onJoin, onOpenChat, onJoinGroup, onDevice, onClose, autoScan = false }: { onJoin?(keys: SessionKeys): void; onOpenChat?(sessionId: string): void; onJoinGroup?(link: string): Promise<void>; onDevice?(code: string): Promise<void>; onClose(): void; autoScan?: boolean }) {
  const { t } = useI18n();
  const closed = useRef(false);
  const busyRef = useRef(false);
  const primary = useRef<HTMLButtonElement>(null);
  const manualInput = useRef<HTMLTextAreaElement>(null);
  const [manual, setManual] = useState(false);
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const generation = useRef(0), joined = useRef(false);
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [own, setOwn] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [starting, setStarting] = useState(false);
  const stop = () => {
    generation.current++;
    busyRef.current = false; setBusy(false);
    stream.current?.getTracks().forEach(track => track.stop());
    stream.current = null;
    setScanning(false); setStarting(false);
  };
  const close = () => { closed.current = true; stop(); onClose(); };
  const backdrop = useBackdropDismiss(close);
  useEffect(() => {
    closed.current = false;
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    primary.current?.focus();
    return () => {
      closed.current = true;
      // This counter deliberately tracks work begun after mounting.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      generation.current++;
      stream.current?.getTracks().forEach(track => track.stop());
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  useEffect(() => { if (manual) manualInput.current?.focus(); }, [manual]);
  const accept = (value: string) => {
    if (joined.current || closed.current) return;
    if (onDevice) {
      // A code that adds this device to a profile: read as one, and nothing else.
      const device = readDeviceInvite(value);
      if (!device.ok) { setError(t(failureKey(device.reason))); setManual(true); return; }
      joined.current = true; stop(); busyRef.current = true; setBusy(true);
      onDevice(value.trim()).catch((cause: unknown) => {
        if (closed.current) return;
        joined.current = false; busyRef.current = false; setBusy(false);
        const key = enrollErrorKey(cause);
        setError(key ? t(key) : cause instanceof Error ? errorText(cause, t) : t("join.invalid")); setManual(true);
      });
      return;
    }
    if (onJoinGroup && (decodeGroupEntryLink(value) || decodeCommunityLink(value))) {
      joined.current = true; stop(); busyRef.current = true; setBusy(true);
      onJoinGroup(value.trim()).catch((cause: unknown) => {
        if (closed.current) return;
        joined.current = false; busyRef.current = false; setBusy(false);
        setError(cause instanceof Error ? errorText(cause, t) : t("join.invalid")); setManual(true);
      });
      return;
    }
    const reading = readInvite(value);
    // A good code that adds a device (WISP 06), scanned from the active device with Join: it goes where such a code goes.
    if (!reading.ok && reading.reason === "device" && readDeviceInvite(value).ok) { joined.current = true; close(); offerDeviceLink(value.trim()); return; }
    // The reason, as WISP 801 words it: a typo, a newer version, not an invite at all, or a damaged one.
    if (!reading.ok) { setError(t(INVITE_REFUSAL_MESSAGE[reading.reason])); setManual(true); return; }
    const outcome = classifyInvite(reading.keys);
    if (outcome.kind === "own") { setError(""); setManual(false); setOwn(outcome.sessionId); return; }
    joined.current = true; stop();
    if (outcome.kind === "joined") { showJoinNotice("join.alreadyIn"); (onOpenChat ?? (() => onJoin?.(reading.keys)))(outcome.sessionId); return; }
    onJoin?.(reading.keys);
  };
  const paste = async () => {
    if (busyRef.current || joined.current || closed.current) return;
    stop(); busyRef.current = true; setBusy(true); setError(""); setOwn(null);
    const current = generation.current;
    try {
      // One click: the desktop app reads natively (no WebKit "Paste" callout); a refusal leaves the field and the shortcut.
      const value = await readClipboardText();
      if (current !== generation.current || closed.current) return;
      // A phone has no keys to press: there the field pastes with a long press.
      const touch = touchOnly();
      if (value === null) { setError(touch ? t("join.clipboardUnavailableTouch") : t("join.clipboardUnavailable", { keys: pasteShortcut() })); setManual(true); return; }
      if (!value.trim()) { setError(touch ? t("join.emptyTouch") : t("join.empty", { keys: pasteShortcut() })); setManual(true); return; }
      accept(value.trim());
    } finally {
      if (current === generation.current && !closed.current) { busyRef.current = false; setBusy(false); }
    }
  };
  const scan = async () => {
    if (busyRef.current || joined.current || closed.current) return;
    stop(); busyRef.current = true; setError(""); setOwn(null); setStarting(true);
    const current = generation.current;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("unsupported");
      const camera = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
      if (current !== generation.current) { camera.getTracks().forEach(track => track.stop()); return; }
      stream.current = camera; setScanning(true); setStarting(false);
      const element = video.current!;
      element.srcObject = camera; await element.play();
      if (current !== generation.current || closed.current) return;
      const canvas = document.createElement("canvas"), context = canvas.getContext("2d", { willReadFrequently: true })!;
      const tick = () => {
        if (current !== generation.current) return;
        if (element.readyState >= 2 && element.videoWidth) {
          const scale = Math.min(1, 960 / element.videoWidth);
          canvas.width = Math.round(element.videoWidth * scale); canvas.height = Math.round(element.videoHeight * scale);
          context.drawImage(element, 0, 0, canvas.width, canvas.height);
          const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
          const qr = jsQR(pixels.data, pixels.width, pixels.height, { inversionAttempts: "attemptBoth" });
          if (qr) { accept(qr.data); if (joined.current) return; }
        }
        window.setTimeout(tick, 160);
      };
      tick();
    } catch {
      if (current !== generation.current) return;
      stop();
      setError(t("join.cameraUnavailable")); setManual(true);
    }
  };
  // Once, on opening, after the dialog is up; `scan` itself stops anything a closed dialog started.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (autoScan) void scan(); }, []);
  const readImage = async (file?: File) => {
    if (!file || busyRef.current || joined.current || closed.current) return;
    stop(); setError("");
    if (file.size > 12 * 1024 * 1024) { setError(t("join.imageSize")); return; }
    busyRef.current = true; setBusy(true);
    const current = generation.current;
    try {
      const bitmap = await createImageBitmap(file);
      try {
        const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
        const canvas = document.createElement("canvas"); canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
        const context = canvas.getContext("2d", { willReadFrequently: true })!;
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        const data = context.getImageData(0, 0, canvas.width, canvas.height);
        const qr = jsQR(data.data, data.width, data.height, { inversionAttempts: "attemptBoth" });
        if (current !== generation.current) return;
        if (qr) accept(qr.data); else setError(t("join.noQr"));
      } finally { bitmap.close(); }
    } catch { if (current === generation.current) setError(t("join.imageFailed")); }
    finally { if (current === generation.current && !closed.current) { busyRef.current = false; setBusy(false); } }
  };
  // A screenshot of the QR, pasted (the desktop app's WebKit hands it as a file) or dropped: read as "Open image" reads
  // one. A paste of text is left to the field.
  const pastedImage = (event: ClipboardEvent) => {
    const image = pastedFiles(event.clipboardData)?.find(file => file.type.startsWith("image/"));
    if (!image) return;
    event.preventDefault();
    void readImage(image);
  };
  const droppedImage = (event: DragEvent) => {
    if (!dragHasFiles(event.dataTransfer)) return;
    // Taken here, so the window does not open the file in place of the app.
    event.preventDefault();
    const file = droppedFiles(event.dataTransfer)[0];
    if (file?.type.startsWith("image/")) void readImage(file);
    else if (file) setError(t("join.imageFailed"));
  };
  const button = "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-sm font-semibold cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40 disabled:cursor-not-allowed";
  return <dialog ref={dialog} {...backdrop} onCancel={event => { event.preventDefault(); close(); }}
    onPaste={pastedImage} onDragOver={event => { if (dragHasFiles(event.dataTransfer)) event.preventDefault(); }} onDrop={droppedImage}
    onKeyDown={event => {
      if (event.key !== "Tab") return;
      const elements = Array.from(dialog.current?.querySelectorAll<HTMLElement>("button:not(:disabled), textarea, input:not(:disabled)") ?? []).filter(element => element.getClientRects().length);
      const first = elements[0], last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}
    aria-labelledby="join-title" className="m-auto w-[calc(100%_-_2rem)] max-w-sm max-h-[85dvh] overflow-y-auto rounded-2xl border border-border bg-sidebar-bg p-5 text-text-primary shadow-2xl backdrop:bg-black/60">
    <div className="mb-4 flex items-center justify-between">
      <h2 id="join-title" className="font-semibold">{onDevice ? t("devices.join.addThis") : t("join.title")}</h2>
      <button onClick={close} aria-label={t("join.close")} className="h-10 w-10 cursor-pointer rounded-lg text-xl hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-accent">×</button>
    </div>
    <video ref={video} muted playsInline aria-label={t("join.cameraPreview")} className={`${scanning ? "block" : "hidden"} mb-3 aspect-square w-full rounded-xl bg-black object-cover`} />
    {scanning || starting ? <button onClick={stop} className={`${button} mb-3 w-full border border-border`}>{t("common.cancel")}</button> : <>
      <button ref={primary} disabled={busy} onClick={() => void paste()} className={`${button} min-h-12 w-full bg-accent text-panel-header`}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0"><rect x="8" y="3" width="8" height="4" rx="1"/><path d="M8 5H6a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M8 12h8M8 16h5"/></svg>
        {t("join.paste")}
      </button>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <button disabled={busy} onClick={() => void scan()} className={`${button} border border-border text-text-secondary`}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0"><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/><rect x="7" y="7" width="3" height="3"/><rect x="14" y="7" width="3" height="3"/><rect x="7" y="14" width="3" height="3"/><path d="M14 14h3v3h-3z"/></svg>
          {t("join.scan")}
        </button>
        <label className={`${button} border border-border text-text-secondary focus-within:ring-2 focus-within:ring-accent ${busy ? "opacity-40" : ""}`}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>
          {t("join.image")}<input disabled={busy} aria-label={t("join.image")} type="file" accept="image/*" className="sr-only" onChange={event => { void readImage(event.target.files?.[0]); event.target.value = ""; }} />
        </label>
      </div>
      <p className="mt-2 text-center text-xs text-text-secondary">{t("join.pasteScreenshot")}</p>
    </>}
    {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
    {own && <div data-testid="join-own-invite" className="mt-3 rounded-lg border border-border bg-input-bg p-3">
      <p role="alert" className="text-sm text-text-primary">{t("join.own")}</p>
      <button type="button" data-testid="join-open-chat" onClick={() => { joined.current = true; stop(); (onOpenChat ?? onClose)(own); }} className={`${button} mt-3 w-full bg-accent text-panel-header`}>{t("join.openChat")}</button>
    </div>}
    {manual && <form className="mt-3" onSubmit={event => { event.preventDefault(); if (!busyRef.current) accept(input.trim()); }}>
      <textarea ref={manualInput} aria-label={t("join.invite")} autoCapitalize="none" autoCorrect="off" spellCheck={false} value={input} onChange={event => { setInput(event.target.value); setError(""); }} placeholder={t("join.placeholder")} rows={3} className="w-full resize-none rounded-lg bg-input-bg p-3 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-accent" />
      <div className="mt-3 grid grid-cols-2 gap-3"><button type="button" onClick={close} className={`${button} border border-border`}>{t("common.cancel")}</button><button disabled={!input.trim() || busy || starting || scanning} className={`${button} bg-accent text-panel-header`}>{t("join.submit")}</button></div>
    </form>}
  </dialog>;
}
