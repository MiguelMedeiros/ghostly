import { useBackdropDismiss } from "../hooks/useDismiss";
import { useEffect, useRef, useState } from "react";
import jsQR from "jsqr";
import { decodeCommunityLink, decodeGroupEntryLink } from "@ghostly/core";
import { parseInvite } from "../lib/url";
import { useI18n } from "../contexts/I18nContext";
import type { SessionKeys } from "../lib/storage";

/**
 * Scanned data is only parsed as an invite; never opened as a URL or executed. A group's link
 * (`group1/…`) goes to `onJoinGroup`, which the dialog waits for, so a refusal is shown here.
 */
export function JoinDialog({ onJoin, onJoinGroup, onClose }: { onJoin(keys: SessionKeys): void; onJoinGroup?(link: string): Promise<void>; onClose(): void }) {
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
    if (onJoinGroup && (decodeGroupEntryLink(value) || decodeCommunityLink(value))) {
      joined.current = true; stop(); busyRef.current = true; setBusy(true);
      onJoinGroup(value.trim()).catch((cause: unknown) => {
        if (closed.current) return;
        joined.current = false; busyRef.current = false; setBusy(false);
        setError(cause instanceof Error ? cause.message : t("join.invalid")); setManual(true);
      });
      return;
    }
    const keys = parseInvite(value);
    if (!keys) { setError(t("join.invalid")); setManual(true); return; }
    joined.current = true; stop(); onJoin(keys);
  };
  const paste = async () => {
    if (busyRef.current || joined.current || closed.current) return;
    stop(); busyRef.current = true; setBusy(true); setError("");
    const current = generation.current;
    try {
      const value = await navigator.clipboard.readText();
      if (current !== generation.current || closed.current) return;
      if (!value.trim()) { setError(t("join.empty")); setManual(true); return; }
      accept(value.trim());
    } catch {
      if (current === generation.current && !closed.current) {
        setError(t("join.clipboardUnavailable")); setManual(true);
      }
    } finally {
      if (current === generation.current && !closed.current) { busyRef.current = false; setBusy(false); }
    }
  };
  const scan = async () => {
    if (busyRef.current || joined.current || closed.current) return;
    stop(); busyRef.current = true; setError(""); setStarting(true);
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
  const button = "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-sm font-semibold cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40 disabled:cursor-not-allowed";
  return <dialog ref={dialog} {...backdrop} onCancel={event => { event.preventDefault(); close(); }}
    onKeyDown={event => {
      if (event.key !== "Tab") return;
      const elements = Array.from(dialog.current?.querySelectorAll<HTMLElement>("button:not(:disabled), textarea, input:not(:disabled)") ?? []).filter(element => element.getClientRects().length);
      const first = elements[0], last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}
    aria-labelledby="join-title" className="m-auto w-[calc(100%_-_2rem)] max-w-sm max-h-[85dvh] overflow-y-auto rounded-2xl border border-border bg-sidebar-bg p-5 text-text-primary shadow-2xl backdrop:bg-black/60">
    <div className="mb-4 flex items-center justify-between">
      <h2 id="join-title" className="font-semibold">{t("join.title")}</h2>
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
    </>}
    {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
    {manual && <form className="mt-3" onSubmit={event => { event.preventDefault(); if (!busyRef.current) accept(input.trim()); }}>
      <textarea ref={manualInput} aria-label={t("join.invite")} autoCapitalize="none" autoCorrect="off" spellCheck={false} value={input} onChange={event => { setInput(event.target.value); setError(""); }} placeholder="Paste invite…" rows={3} className="w-full resize-none rounded-lg bg-input-bg p-3 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-accent" />
      <div className="mt-3 grid grid-cols-2 gap-3"><button type="button" onClick={close} className={`${button} border border-border`}>{t("common.cancel")}</button><button disabled={!input.trim() || busy || starting || scanning} className={`${button} bg-accent text-panel-header`}>{t("join.submit")}</button></div>
    </form>}
  </dialog>;
}
