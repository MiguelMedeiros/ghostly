import { useEffect, useState, type MouseEvent } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { APP_WEBSITE } from "../lib/settings";
import { useI18n } from "../contexts/I18nContext";

// Published release verified through GitHub's releases API. Unknown future
// versions link to the index until their corresponding release is verified.
const publishedReleases: Record<string, string> = {
  "0.4.0": "https://github.com/MiguelMedeiros/ghostly/releases/tag/v0.4.0",
};

export function HomeProjectLinks() {
  const { t } = useI18n();
  const [version, setVersion] = useState<string>();
  const [failed, setFailed] = useState(false);
  useEffect(() => { let active = true; getVersion().then(v => { if (active) setVersion(v); }).catch(() => {}); return () => { active = false; }; }, []);
  const release = version ? publishedReleases[version] : undefined;
  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    event.preventDefault();
    setFailed(false);
    invoke("open_project_link", { url: event.currentTarget.href }).catch(() => setFailed(true));
  };
  const linkStyle = "inline-flex min-h-11 items-center gap-1.5 rounded px-2 text-xs text-text-muted hover:text-text-primary cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";
  return (
    <footer className="flex shrink-0 flex-wrap items-center justify-end gap-1 px-4 pb-[max(8px,env(safe-area-inset-bottom))]">
      {failed && <span role="status" className="text-xs text-danger">{t("home.linkFailed")}</span>}
      <a href={APP_WEBSITE} target="_blank" rel="noopener noreferrer" onClick={open} className={linkStyle}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .8a11.2 11.2 0 0 0-3.54 21.83c.56.1.77-.24.77-.54v-2.09c-3.13.68-3.79-1.33-3.79-1.33-.51-1.3-1.25-1.65-1.25-1.65-1.02-.7.08-.68.08-.68 1.13.08 1.72 1.16 1.72 1.16 1 1.71 2.63 1.22 3.27.93.1-.72.39-1.22.71-1.5-2.5-.28-5.13-1.25-5.13-5.56 0-1.23.44-2.23 1.16-3.01-.12-.28-.5-1.43.11-2.97 0 0 .95-.3 3.08 1.15a10.7 10.7 0 0 1 5.61 0c2.14-1.45 3.08-1.15 3.08-1.15.61 1.54.23 2.69.11 2.97.72.78 1.16 1.78 1.16 3.01 0 4.32-2.63 5.28-5.14 5.56.4.35.76 1.03.76 2.08v3.08c0 .3.2.65.77.54A11.2 11.2 0 0 0 12 .8Z"/></svg>
        GitHub
      </a>
      {version && <a href={release ?? `${APP_WEBSITE}/releases`} target="_blank" rel="noopener noreferrer" onClick={open}
        aria-label={`${t("settings.version")} ${version}`}
        title={release ? t("home.viewRelease") : t("home.unpublishedVersion")}
        className={`${linkStyle} font-mono`}>v{version}</a>}
    </footer>
  );
}
