import { useRef } from "react";
import { useI18n } from "../contexts/I18nContext";
import { useUpdate } from "../contexts/UpdateContext";
import { tabbables } from "../hooks/useDismiss";
import { externalLinkProps } from "../lib/externalLink";

/**
 * A new version exists. Nothing happens until the user says so: applying one
 * ends every call and every connection this client holds, and on the web it
 * reloads the tab.
 * While it installs its buttons are busy, not disabled: that would drop a keyboard's focus to the page, and on Desktop
 * an install can take long or fail.
 */
export function UpdateBanner() {
  const { t } = useI18n();
  const { update, dismissed, stage, progress, error, install, dismiss, downloadUrl } = useUpdate();
  const banner = useRef<HTMLDivElement>(null);

  const shown = !!update && !dismissed;
  const installing = stage === "installing";
  const busy = installing || undefined;
  const downloading = (percent: number) => percent > 0 ? t("updates.downloading", { percent: String(percent) }) : t("updates.installing");
  const title = update && t(update.replaced ? "updates.replaced" : "updates.available", { version: update.version });

  /** Later takes the banner out with the focus in it: the focus goes on to what Tab would reach next, not the page. */
  const later = () => {
    if (busy) return;
    const box = banner.current;
    if (box?.contains(document.activeElement)) {
      const all = tabbables(document.body).filter((el) => !box.contains(el));
      const after = all.find((el) => box.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
      (after ?? all[all.length - 1])?.focus({ preventScroll: true });
    }
    dismiss();
  };

  return (
    <>
      {/* Said politely in a line of its own, always there, as a live region must be before what it says. The desktop's
          download reports every chunk: said aloud, the percent moves in tens. */}
      <div role="status" className="sr-only">
        {shown && <>
          <p>{title}</p>
          {installing ? <p>{downloading(Math.floor(progress * 10) * 10)}</p> : error && <p>{error}</p>}
        </>}
      </div>
      {shown && (
        <div
          ref={banner}
          className="shrink-0 border-b border-border bg-accent/10 px-4 py-2.5 flex items-center gap-3"
          data-testid="update-banner"
        >
          <div className="min-w-0 flex-1">
            <p className="text-text-primary text-xs font-semibold m-0 truncate">{title}</p>
            <p className="text-text-muted text-[11px] m-0 truncate">
              {installing
                ? downloading(Math.round(progress * 100))
                : error
                  ? error
                  : t(update.apply === "manual" ? "updates.manualHint" : "updates.applyHint")}
            </p>
          </div>

          {update.apply === "manual" ? (
            <a
              {...externalLinkProps(downloadUrl)}
              className="shrink-0 px-3 py-1.5 bg-accent hover:bg-accent-hover text-on-accent rounded-lg text-xs font-semibold transition-colors"
            >
              {t("updates.download")}
            </a>
          ) : (
            <button
              onClick={() => { if (!busy) void install(); }}
              aria-disabled={busy}
              aria-busy={busy}
              className="shrink-0 px-3 py-1.5 bg-accent hover:bg-accent-hover text-on-accent rounded-lg text-xs font-semibold transition-colors aria-disabled:opacity-60 aria-disabled:cursor-progress cursor-pointer"
            >
              {t(update.apply === "restart" ? "updates.restart" : "updates.reload")}
            </button>
          )}

          <button
            onClick={later}
            aria-disabled={busy}
            aria-label={t("updates.later")}
            className="shrink-0 text-text-muted hover:text-text-primary transition-colors text-lg leading-none cursor-pointer aria-disabled:opacity-40 aria-disabled:cursor-not-allowed"
          >
            ×
          </button>
        </div>
      )}
    </>
  );
}
