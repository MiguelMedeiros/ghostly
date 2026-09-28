import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useBackdropDismiss } from "../hooks/useDismiss";
import { useI18n } from "../contexts/I18nContext";

/** How large a picture is drawn at most, in CSS pixels, when it arrived smaller: 2.5× a 128 px profile picture. */
const SHOWN = 320;
/** How far a small picture is scaled up at most, so it is never stretched into a blur. */
const UPSCALE = 2.5;

/** The width a picture of `natural` pixels is drawn at: as it arrived when large, scaled up (smoothly, within limits) when small. */
const viewerWidth = (natural: number) => Math.max(natural, Math.min(natural * UPSCALE, SHOWN));

/**
 * A contact's or a group's picture, large: centered over the page with the name under it, a full-screen sheet on a
 * phone. Escape, the close button and a click outside the picture close it, and the focus goes back to what opened
 * it. `src` is a checked data URL (the engine's `sanitizeAvatar`), drawn and never fetched.
 */
export function AvatarViewer({ src, name, onClose, returnFocus }: { src: string; name: string; onClose: () => void; returnFocus?: RefObject<HTMLElement | null> }) {
  const { t } = useI18n();
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const backdrop = useBackdropDismiss(onClose);
  const [natural, setNatural] = useState<number>();
  useEffect(() => {
    const element = dialog.current!, opener = returnFocus?.current, before = document.activeElement as HTMLElement | null;
    element.showModal();
    // The keys go to the viewer, even where opening it left the focus outside (a browser that moves none in).
    if (!element.contains(document.activeElement)) element.focus({ preventScroll: true });
    return () => {
      element.close();
      // Back to the avatar: a click on a button does not always focus it (WebKit), so what opened it is named.
      const back = opener?.isConnected ? opener : before?.isConnected ? before : null;
      back?.focus({ preventScroll: true });
    };
  }, [returnFocus]);
  return createPortal(
    // Escape is handled here, before the page's own handlers: a panel under the viewer (a contact's identities)
    // closes on Escape at the document, and must stay open when only the viewer goes.
    <dialog ref={dialog} tabIndex={-1} aria-labelledby={`${id}-name`} data-testid="avatar-viewer"
      onKeyDown={e => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); } }}
      onCancel={e => { e.preventDefault(); onClose(); }} onClose={onClose}
      className="fixed inset-0 m-0 h-full max-h-none w-full max-w-none bg-transparent p-0 text-text-primary backdrop:bg-black/75">
      <div {...backdrop} data-testid="avatar-viewer-backdrop" className="flex h-full w-full items-center justify-center p-4 max-md:bg-sidebar-bg max-md:p-0">
        <figure className="m-0 flex max-w-full flex-col items-center gap-3">
          <img src={src} alt="" draggable={false} data-testid="avatar-viewer-image" onLoad={e => setNatural(e.currentTarget.naturalWidth || undefined)}
            style={{ width: `min(${viewerWidth(natural ?? 128)}px, calc(100vw - 2rem), 70dvh)`, height: "auto" }}
            className="aspect-square rounded-2xl object-cover shadow-2xl max-md:rounded-xl" />
          <figcaption id={`${id}-name`} className="max-w-full truncate px-2 text-base font-medium text-white max-md:text-text-primary"><bdi>{name}</bdi></figcaption>
        </figure>
      </div>
      <button type="button" aria-label={t("common.close")} data-testid="avatar-viewer-close" onClick={onClose}
        style={{ top: "max(0.75rem, env(safe-area-inset-top))" }}
        className="absolute end-3 flex h-11 w-11 items-center justify-center rounded-full bg-black/40 text-white hover:bg-black/60 max-md:bg-transparent max-md:text-text-secondary max-md:hover:bg-surface-hover">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
      </button>
    </dialog>,
    document.body,
  );
}

/**
 * An avatar that opens its picture large: with a picture, a button named "View photo of <name>"; without one, the
 * avatar as it is (an initial or a glyph is not worth a viewer). `className` goes on either, so the layout is the same.
 */
export function AvatarOpener({ src, name, className = "", testId, children }: { src?: string; name: string; className?: string; testId?: string; children: ReactNode }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  if (!src) return <div className={className}>{children}</div>;
  return <>
    <button ref={button} type="button" aria-label={t("common.viewPhoto", { name })} data-testid={testId} onClick={() => setOpen(true)}
      className={`${className} cursor-zoom-in focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent`}>
      {children}
    </button>
    {open && <AvatarViewer src={src} name={name} returnFocus={button} onClose={() => setOpen(false)} />}
  </>;
}
