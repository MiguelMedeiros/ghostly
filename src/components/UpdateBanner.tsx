import { useI18n } from "../contexts/I18nContext";
import { useUpdate } from "../contexts/UpdateContext";

/**
 * A new version exists. Nothing happens until the user says so: applying one
 * ends every call and every connection this client holds, and on the web it
 * reloads the tab.
 */
export function UpdateBanner() {
  const { t } = useI18n();
  const { update, dismissed, stage, progress, error, install, dismiss, downloadUrl } = useUpdate();

  if (!update || dismissed) return null;

  const installing = stage === "installing";
  const percent = Math.round(progress * 100);

  return (
    <div
      className="shrink-0 border-b border-border bg-accent/10 px-4 py-2.5 flex items-center gap-3"
      data-testid="update-banner"
    >
      <div className="min-w-0 flex-1">
        <p className="text-text-primary text-xs font-semibold m-0 truncate">
          {t("updates.available", { version: update.version })}
        </p>
        <p className="text-text-muted text-[11px] m-0 truncate">
          {installing
            ? percent > 0
              ? t("updates.downloading", { percent: String(percent) })
              : t("updates.installing")
            : error
              ? error
              : t(update.apply === "manual" ? "updates.manualHint" : "updates.applyHint")}
        </p>
      </div>

      {update.apply === "manual" ? (
        <a
          href={downloadUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 px-3 py-1.5 bg-accent hover:bg-accent-hover text-on-accent rounded-lg text-xs font-semibold transition-colors"
        >
          {t("updates.download")}
        </a>
      ) : (
        <button
          onClick={() => void install()}
          disabled={installing}
          className="shrink-0 px-3 py-1.5 bg-accent hover:bg-accent-hover text-on-accent rounded-lg text-xs font-semibold transition-colors disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
        >
          {t(update.apply === "restart" ? "updates.restart" : "updates.reload")}
        </button>
      )}

      <button
        onClick={dismiss}
        disabled={installing}
        aria-label={t("updates.later")}
        className="shrink-0 text-text-muted hover:text-text-primary transition-colors text-lg leading-none cursor-pointer disabled:opacity-40"
      >
        ×
      </button>
    </div>
  );
}
