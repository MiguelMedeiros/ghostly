import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../contexts/I18nContext";
import { useBackdropDismiss, useDialogFocus } from "../../hooks/useDismiss";

/**
 * Whether this device has a camera to take a photo with. Browsers list their devices before any permission
 * (without names), so this asks nothing; where it cannot tell, there is no Camera row.
 */
export function useHasCamera(): boolean {
  const [has, setHas] = useState(false);
  useEffect(() => {
    let live = true;
    const devices = navigator.mediaDevices;
    if (!devices?.getUserMedia || !devices.enumerateDevices) return;
    devices.enumerateDevices().then((list) => { if (live) setHas(list.some((d) => d.kind === "videoinput")); }, () => {});
    return () => { live = false; };
  }, []);
  return has;
}

/** A touch phone opens its own camera app from a file input; a desktop takes the photo here. */
export const cameraByFileInput = () => window.matchMedia("(pointer: coarse)").matches;

/**
 * A photo from the desktop's camera: the live picture, a shutter, then the photo with Retake and Send. The
 * camera stops as soon as the photo is taken or the dialog closes.
 */
export function CameraCapture({ onSend, onClose }: { onSend: (file: File) => void; onClose: () => void }) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const [photo, setPhoto] = useState<{ blob: Blob; url: string } | null>(null);
  const [failed, setFailed] = useState(false);
  const backdrop = useBackdropDismiss(onClose);
  useDialogFocus(ref, onClose);

  useEffect(() => {
    if (photo) return;
    let live = true;
    navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false }).then((s) => {
      if (!live) { s.getTracks().forEach((track) => track.stop()); return; }
      stream.current = s;
      if (video.current) { video.current.srcObject = s; void video.current.play().catch(() => {}); }
    }, () => { if (live) setFailed(true); });
    return () => { live = false; stream.current?.getTracks().forEach((track) => track.stop()); stream.current = null; };
  }, [photo]);

  useEffect(() => () => { if (photo) URL.revokeObjectURL(photo.url); }, [photo]);

  const shoot = () => {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    const canvas = document.createElement("canvas");
    canvas.width = v.videoWidth; canvas.height = v.videoHeight;
    canvas.getContext("2d")?.drawImage(v, 0, 0);
    canvas.toBlob((blob) => { if (blob) setPhoto({ blob, url: URL.createObjectURL(blob) }); }, "image/jpeg", 0.9);
  };
  const send = () => {
    if (!photo) return;
    const stamp = new Date().toISOString().slice(0, 19).replace("T", " ").replace(/:/g, ".");
    onSend(new File([photo.blob], `Photo ${stamp}.jpg`, { type: "image/jpeg" }));
  };

  const button = "min-h-10 px-4 rounded-full text-sm font-medium cursor-pointer";
  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4 animate-fade-in" {...backdrop}>
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={t("composer.camera")} data-testid="camera-capture"
        className="focus:outline-none w-full max-w-xl bg-panel-header border border-border rounded-2xl shadow-2xl overflow-hidden">
        <div className="relative aspect-video bg-black">
          {failed ? <p role="alert" className="absolute inset-0 flex items-center justify-center text-sm text-white/80 p-6 text-center">{t("composer.cameraFailed")}</p>
            : photo ? <img src={photo.url} alt="" className="w-full h-full object-contain" data-testid="camera-photo" />
            : <video ref={video} muted playsInline className="w-full h-full object-cover -scale-x-100" data-testid="camera-video" />}
          <button type="button" onClick={onClose} aria-label={t("composer.closeCamera")} title={t("composer.closeCamera")}
            className="absolute top-2 end-2 w-9 h-9 rounded-full bg-black/50 text-white flex items-center justify-center cursor-pointer">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>
        <div className="flex items-center justify-center gap-3 p-3">
          {photo ? <>
            <button type="button" data-testid="camera-retake" onClick={() => setPhoto(null)} className={`${button} bg-surface-alt text-text-primary border border-border`}>{t("composer.retake")}</button>
            <button type="button" data-testid="camera-send" onClick={send} className={`${button} bg-accent text-on-accent hover:bg-accent-hover`}>{t("composer.sendPhoto")}</button>
          </> : (
            <button type="button" data-testid="camera-shutter" onClick={shoot} disabled={failed} aria-label={t("composer.takePhoto")} title={t("composer.takePhoto")}
              className="w-14 h-14 rounded-full border-4 border-text-primary/80 bg-transparent cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center">
              <span className="block w-10 h-10 rounded-full bg-text-primary/90" />
            </button>
          )}
        </div>
      </div>
    </div>, document.body);
}
