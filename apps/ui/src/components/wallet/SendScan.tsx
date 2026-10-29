import { useEffect, useRef, useState, type ClipboardEvent, type ReactNode } from "react";
import { dragHasFiles, droppedFiles, pastedFiles, pasteIsPictureOnly, pasteNamesFiles, pasteShowsNothing, platformPastedImage } from "../../lib/pastedFiles";
import { readClipboardText } from "../../lib/clipboard";
import { rawError } from "../../lib/errorText";
import { QR_IMAGE_MAX, QrReaderNotLoaded, qrCamera, qrDecoder, qrReaderFailures, readQrImage, scanQrFrames } from "../../lib/qrReader";
import { useI18n } from "../../contexts/I18nContext";
import { Notice } from "../ui/Notice";

/**
 * How Send on the Lightning and Cashu cards is given what to pay, as a phone wallet is: Scan (the camera), Paste, or
 * Choose image (a screenshot of a QR); a picture pasted or dropped anywhere in it (`children`: the card's field, where
 * one types) is read the same way. The text found goes to `onText` as is: the card sorts it.
 */
export function SendScan({ onText, disabled = false, children }: { onText: (text: string) => void; disabled?: boolean; children?: ReactNode }) {
  const { t } = useI18n();
  const video = useRef<HTMLVideoElement>(null);
  const scanButton = useRef<HTMLButtonElement>(null);
  const stopButton = useRef<HTMLButtonElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const generation = useRef(0);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const stop = () => {
    generation.current++;
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    setScanning(false); setBusy(false);
  };
  // The camera never outlives the card's Send.
  useEffect(() => () => {
    generation.current++;
    stream.current?.getTracks().forEach((track) => track.stop());
  }, []);
  // Scan and the camera's Cancel take each other's place: the keys that were on one go to the other.
  const wasScanning = useRef(scanning);
  useEffect(() => {
    if (wasScanning.current === scanning) return;
    wasScanning.current = scanning;
    if (!document.activeElement || document.activeElement === document.body) (scanning ? stopButton : scanButton).current?.focus();
  }, [scanning]);
  const readerFailed = () => t(qrReaderFailures() < 2 ? "join.qrReaderNotLoaded" : "join.qrReaderReload");

  const scan = async () => {
    stop(); setError(""); setBusy(true);
    const current = generation.current;
    const decoding = qrDecoder();
    decoding.catch(() => {});
    try {
      const camera = await qrCamera();
      if (current !== generation.current) { camera.getTracks().forEach((track) => track.stop()); return; }
      stream.current = camera; setScanning(true);
      const element = video.current!;
      element.srcObject = camera; await element.play();
      const jsQR = await decoding;
      if (current !== generation.current) return;
      scanQrFrames(element, jsQR, () => current === generation.current, (data) => { stop(); onText(data); return true; });
    } catch (cause) {
      if (current !== generation.current) return;
      stop();
      setError(cause instanceof QrReaderNotLoaded ? readerFailed() : t("wallet.send.cameraUnavailable"));
    }
  };
  const paste = async () => {
    stop(); setError(""); setBusy(true);
    const current = generation.current;
    try {
      const text = await readClipboardText();
      if (current !== generation.current) return;
      if (text === null) setError(t("wallet.send.clipboardUnavailable"));
      else if (!text.trim()) setError(t("wallet.send.clipboardEmpty"));
      else onText(text.trim());
    } finally { if (current === generation.current) setBusy(false); }
  };
  // `weighed`: a picture the app read from the clipboard, already checked there (`platformPastedImage`).
  const image = async (file?: File, weighed = false) => {
    if (!file) return;
    stop(); setError("");
    if (!weighed && file.size > QR_IMAGE_MAX) { setError(t("join.imageSize")); return; }
    setBusy(true);
    const current = generation.current;
    try {
      const text = await readQrImage(file);
      if (current !== generation.current) return;
      if (text === null) setError(t("join.noQr")); else onText(text.trim());
    } catch (cause) { if (current === generation.current) setError(cause instanceof QrReaderNotLoaded ? readerFailed() : t("join.imageFailed")); }
    finally { if (current === generation.current) setBusy(false); }
  };
  // A screenshot of a QR, pasted: read as Choose image reads one. A paste of text is left to the field.
  const pasted = (event: ClipboardEvent) => {
    const file = pastedFiles(event.clipboardData)?.find((f) => f.type.startsWith("image/"));
    if (file) { if (!off) { event.preventDefault(); void image(file); } return; }
    // The Linux app's webview shows the page nothing of a copied picture (no files, no text; a browser's copy, its HTML
    // and address only): the app reads it, as Join does.
    const picture = pasteIsPictureOnly(event.clipboardData);
    if (off || !(picture || pasteShowsNothing(event.clipboardData))) return;
    const reading = platformPastedImage(QR_IMAGE_MAX);
    if (!reading) return;
    event.preventDefault();
    stop(); setError(""); setBusy(true);
    const current = generation.current, named = picture || pasteNamesFiles(event.clipboardData);
    const ended = () => { if (current !== generation.current) return false; setBusy(false); return true; };
    reading.then((found) => {
      if (!ended()) return;
      if (found === "tooLarge") setError(t("join.imageSize"));
      else if (found === "tooManyPixels") setError(t("join.pastedTooLarge"));
      else if (found) void image(found, true);
      // Copied files with no picture among them are said, as a dropped one is; an empty clipboard stays quiet.
      else if (named) setError(t("join.imageFailed"));
    }, (cause: unknown) => {
      if (ended()) setError(t(rawError(cause) === "That picture is too large to paste" ? "join.pastedTooLarge" : "join.imageFailed"));
    });
  };

  // `aria-disabled`, not disabled: a disabled control gives up the keyboard's focus while it runs (as wallet/ui.tsx's Button).
  const off = disabled || busy;
  const control = "inline-flex min-h-11 items-center justify-center rounded-lg text-sm font-semibold cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent aria-disabled:opacity-40 aria-disabled:cursor-not-allowed";
  // A third of a phone's card each: the icon above its label, as a phone wallet's row, or the label is cut ("Scansiona"
  // past its button, "スキャン" broken in two).
  const tile = `${control} flex-col gap-1 p-2 text-center leading-tight`;
  return (
    <div className="space-y-3" data-testid="wallet-send-scan"
      // A screenshot of a QR, dropped: read as Choose image reads one.
      onPaste={pasted}
      onDragOver={(event) => { if (dragHasFiles(event.dataTransfer)) event.preventDefault(); }}
      onDrop={(event) => { if (!dragHasFiles(event.dataTransfer)) return; event.preventDefault(); const file = droppedFiles(event.dataTransfer)[0]; if (file?.type.startsWith("image/")) { if (!off) void image(file); } else if (file) setError(t("join.imageFailed")); }}>
      <video ref={video} muted playsInline aria-label={t("join.cameraPreview")} className={`${scanning ? "block" : "hidden"} aspect-square w-full max-w-xs mx-auto rounded-xl bg-black object-cover`} />
      {scanning ? <button ref={stopButton} type="button" onClick={stop} className={`${control} gap-2 px-3 py-2 w-full border border-border`} data-testid="wallet-send-scan-stop">{t("common.cancel")}</button> : (
        <div className="grid grid-cols-3 gap-2">
          <button ref={scanButton} type="button" aria-disabled={off || undefined} onClick={() => { if (!off) void scan(); }} className={`${tile} bg-accent text-on-accent`} data-testid="wallet-send-camera">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0"><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/><rect x="7" y="7" width="3" height="3"/><rect x="14" y="7" width="3" height="3"/><rect x="7" y="14" width="3" height="3"/><path d="M14 14h3v3h-3z"/></svg>
            {t("wallet.send.scan")}
          </button>
          <button type="button" aria-disabled={off || undefined} onClick={() => { if (!off) void paste(); }} className={`${tile} border border-border text-text-secondary`} data-testid="wallet-send-paste">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0"><rect x="8" y="3" width="8" height="4" rx="1"/><path d="M8 5H6a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/></svg>
            {t("wallet.send.paste")}
          </button>
          <label className={`${tile} border border-border text-text-secondary focus-within:ring-2 focus-within:ring-accent ${off ? "opacity-40 cursor-not-allowed" : ""}`}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>
            {t("wallet.send.image")}<input aria-disabled={off || undefined} onClick={(event) => { if (off) event.preventDefault(); }} aria-label={t("wallet.send.image")} data-testid="wallet-send-image" type="file" accept="image/*" className="sr-only" onChange={(event) => { void image(event.target.files?.[0]); event.target.value = ""; }} />
          </label>
        </div>
      )}
      {error && <Notice tone="error" testId="wallet-send-scan-error">{error}</Notice>}
      {children}
    </div>
  );
}
