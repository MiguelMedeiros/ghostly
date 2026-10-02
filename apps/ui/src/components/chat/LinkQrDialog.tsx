import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { QRCodeSVG } from "qrcode.react";
import { useI18n } from "../../contexts/I18nContext";
import { useBackdropDismiss, useDialogFocus } from "../../hooks/useDismiss";
import { copyText } from "../../lib/shareLink";
import { cardQuiet } from "./EntityCardFrame";

/** How long Copy says Copied. */
const COPIED_MS = 1500;

/**
 * Copies a link on a click and says so for a moment; `failed` when neither way of copying worked. The link is
 * a secret that lets someone in: it goes to the clipboard and nowhere else.
 */
function useCopyLink(url: string) {
  const [state, setState] = useState<"" | "copied" | "failed">("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    clearTimeout(timer.current);
    try {
      await copyText(url);
      setState("copied");
      timer.current = setTimeout(() => setState(""), COPIED_MS);
    } catch { setState("failed"); }
  };
  return { copied: state === "copied", failed: state === "failed", copy };
}

/**
 * A link as a QR, to scan with another device: an invite or a group's link from a card in a chat, or this chat's own
 * invite. `qr` is what the code holds when it is not `url` itself (an invite's link in capitals). A dialog, and a sheet
 * on a phone. It opens on a click only, and Escape, Close or a tap outside closes it.
 */
export function LinkQrDialog({ title, url, qr, onClose }: { title: string; url: string; qr?: string[]; onClose(): void }) {
  const { t } = useI18n();
  const id = useId();
  const dialog = useRef<HTMLDivElement>(null);
  useDialogFocus(dialog, onClose);
  const backdrop = useBackdropDismiss(onClose);
  const { copied, failed, copy } = useCopyLink(url);
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 max-md:p-0 animate-fade-in" {...backdrop}>
      <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-hint`} data-testid="link-qr"
        className="sheet sheet-padded focus:outline-none w-full max-w-sm max-h-[90dvh] overflow-y-auto bg-panel-header border border-border rounded-2xl shadow-2xl p-5 text-center text-text-primary">
        <h2 id={`${id}-title`} className="m-0 text-lg font-medium">{title}</h2>
        <p id={`${id}-hint`} className="m-0 mt-1 text-xs text-text-muted">{t("chat.entity.qrHint")}</p>
        {/* It gives up some of its size on a short screen before the sheet has to scroll. */}
        <div data-testid="link-qr-code" className="mx-auto mt-4 w-fit max-w-full rounded-2xl bg-white p-3 [&_svg]:h-auto [&_svg]:max-w-full [&_svg]:w-[clamp(140px,34dvh,232px)]">
          <QRCodeSVG value={qr ?? url} size={232} marginSize={1} title={t("chat.entity.qrTitle")} bgColor="#ffffff" fgColor="#0b0f1a" level="M" />
        </div>
        <input readOnly value={url} dir="ltr" aria-label={t("chat.entity.link")} data-testid="link-qr-url" onFocus={e => e.currentTarget.select()}
          className="mt-4 w-full min-w-0 rounded-lg bg-input-bg px-3 py-2.5 font-mono text-xs text-text-secondary focus:outline-none focus:ring-1 focus:ring-accent" />
        <div className="mt-3 flex gap-2">
          <button type="button" data-testid="link-qr-copy" onClick={() => void copy()}
            className="min-h-11 flex-1 rounded-lg bg-accent px-4 text-sm font-semibold text-on-accent cursor-pointer hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-panel-header">
            <span role="status">{copied ? t("common.copied") : t("common.copy")}</span>
          </button>
          <button type="button" data-testid="link-qr-close" onClick={onClose}
            className="min-h-11 flex-1 rounded-lg bg-surface-alt px-4 text-sm font-semibold text-text-primary cursor-pointer hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
            {t("common.close")}
          </button>
        </div>
        {failed && <p role="alert" className="m-0 mt-2 text-xs text-danger">{t("group.link.copyFailed")}</p>}
      </div>
    </div>, document.body);
}

/**
 * Copy and Show QR for a card's link, beside what the card does. Nothing is copied or opened until a click.
 * `name` is the card's test id, so each card's buttons can be told apart.
 */
export function LinkActions({ name, title, url, qr }: { name: string; title: string; url: string; qr?: string[] }) {
  const { t } = useI18n();
  const [showQr, setShowQr] = useState(false);
  const { copied, failed, copy } = useCopyLink(url);
  return <>
    <button type="button" data-testid={`${name}-copy`} className={cardQuiet} onClick={() => void copy()}>
      <span role="status">{copied ? t("common.copied") : t("common.copy")}</span>
    </button>
    <button type="button" data-testid={`${name}-qr`} aria-haspopup="dialog" className={cardQuiet} onClick={() => setShowQr(true)}>{t("group.link.showQr")}</button>
    {failed && <p role="alert" className="m-0 basis-full text-danger-ink">{t("group.link.copyFailed")}</p>}
    {showQr && <LinkQrDialog title={title} url={url} qr={qr} onClose={() => setShowQr(false)} />}
  </>;
}
