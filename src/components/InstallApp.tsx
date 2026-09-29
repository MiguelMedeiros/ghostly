import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../contexts/I18nContext";
import { useBackdropDismiss } from "../hooks/useDismiss";
import { useIsMobile } from "../hooks/useIsMobile";
import {
  canInstall, closeInstallSteps, dismissInstallHint, startInstall, useInstallHint, useInstallState, useInstallStepsOpen,
} from "../lib/installPrompt";

/*
 * Installing the web app, where people look for it (src/lib/installPrompt.ts has the states): Install app in the
 * account menu, a hint above the chat list once the app has been used a little, and the steps for Safari, which
 * keeps it in a menu of its own. Nothing here shows in the extension or Desktop (their state is always `none`), nor
 * once the app is installed.
 */

/** A screen with an arrow coming down into it. */
export function InstallIcon({ size = 18 }: { size?: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 4H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2" />
      <path d="M12 2v10M8.5 8.5 12 12l3.5-3.5M9 22h6M12 18v4" />
    </svg>
  );
}

/** Safari's Share button: a box with an arrow going up out of it. */
function ShareGlyph() {
  return (
    <svg data-testid="install-share-glyph" aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="inline-block align-[-3px] text-link">
      <path d="M12 3v12M8 7l4-4 4 4" />
      <path d="M8 10H6a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-9a1 1 0 0 0-1-1h-2" />
    </svg>
  );
}

/** Install app, the account menu's last row (the switcher's popover and phone sheet): only while there is something to install. */
export function InstallMenuItem({ className, onClose }: { className: string; onClose: () => void }) {
  const { t } = useI18n();
  const state = useInstallState();
  if (!canInstall(state)) return null;
  return <>
    <div role="none" className="my-1 border-t border-border" />
    <button type="button" role="menuitem" data-testid="install-app-menu" onClick={() => { onClose(); startInstall(); }} className={className}>
      <span aria-hidden="true" className="grid place-items-center w-8 h-8 shrink-0 text-accent"><InstallIcon /></span>
      {t("pwa.installApp")}
    </button>
  </>;
}

/**
 * Above the chat list, once: Install Ghostly, or Not now, which puts it away for good in this browser (Install stays
 * in the account menu and Settings). Never on a first screen with nothing in it (`installHintShown`).
 */
export function InstallHint({ hasChats }: { hasChats: boolean }) {
  const { t } = useI18n();
  if (!useInstallHint(hasChats)) return null;
  return (
    // The buttons go under the text when the list is too narrow for both (a 280px sidebar, a long language).
    <div role="region" aria-label={t("pwa.installLabel")} data-testid="install-hint" className="shrink-0 border-b border-border bg-accent/10 px-4 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <div className="min-w-44 flex-1 flex items-center gap-3">
        <span aria-hidden="true" className="shrink-0 text-accent"><InstallIcon size={20} /></span>
        <div className="min-w-0 flex-1">
          <p className="text-text-primary text-xs font-semibold m-0 truncate">{t("pwa.installLabel")}</p>
          <p className="text-text-muted text-[11px] m-0 line-clamp-2">{t("pwa.installHint")}</p>
        </div>
      </div>
      <div className="ms-auto shrink-0 flex items-center gap-1">
        <button type="button" data-testid="install-hint-later" onClick={dismissInstallHint}
          className="min-h-9 px-2 rounded-lg text-xs whitespace-nowrap text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
          {t("pwa.notNow")}
        </button>
        <button type="button" data-testid="install-hint-install" onClick={startInstall}
          className="min-h-9 px-3 bg-accent hover:bg-accent-hover text-on-accent rounded-lg text-xs font-semibold whitespace-nowrap transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar-bg">
          {t("pwa.install")}
        </button>
      </div>
    </div>
  );
}

/**
 * The steps where the browser has no prompt to show: Share, then Add to Home Screen on an iPhone or iPad; File,
 * then Add to Dock in Safari on a Mac. Mounted once beside the app (both layouts); `startInstall` opens it.
 */
export function InstallSteps() {
  const open = useInstallStepsOpen();
  const state = useInstallState();
  if (!open || (state !== "ios" && state !== "dock")) return null;
  return <StepsDialog kind={state} />;
}

function StepsDialog({ kind }: { kind: "ios" | "dock" }) {
  const { t } = useI18n();
  const id = useId();
  const phone = useIsMobile();
  const dialog = useRef<HTMLDialogElement>(null), done = useRef<HTMLButtonElement>(null);
  const backdrop = useBackdropDismiss(closeInstallSteps);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const element = dialog.current!;
    element.showModal();
    done.current?.focus();
    return () => { element.close(); if (previous?.isConnected) previous.focus(); };
  }, []);

  // The Share glyph where the words name it ("{{icon}}" in every language).
  const [beforeIcon, afterIcon = ""] = t("pwa.iosStep1").split("{{icon}}");
  const steps = kind === "ios"
    ? [<>{beforeIcon}<ShareGlyph />{afterIcon}</>, t("pwa.iosStep2")]
    : [t("pwa.dockStep1"), t("pwa.dockStep2")];

  return createPortal(
    <dialog ref={dialog} {...backdrop} data-testid="install-steps" data-kind={kind} aria-labelledby={`${id}-title`}
      onCancel={(e) => { e.preventDefault(); closeInstallSteps(); }}
      className={`${phone ? "mt-auto mb-0 w-full max-w-none rounded-t-2xl border-t pb-[calc(1.25rem+env(safe-area-inset-bottom))]" : "m-auto w-[calc(100%_-_2rem)] max-w-sm rounded-2xl border"} border-border bg-sidebar-bg p-5 text-text-primary shadow-2xl backdrop:bg-black/60`}>
      {phone && <div aria-hidden="true" className="mx-auto -mt-2 mb-3 h-1 w-9 rounded-full bg-border-bright" />}
      <div className="flex items-center gap-3">
        <span aria-hidden="true" className="grid place-items-center w-10 h-10 shrink-0 rounded-xl bg-accent/15 text-accent"><InstallIcon size={22} /></span>
        <h2 id={`${id}-title`} className="text-base font-semibold">{t(kind === "ios" ? "pwa.iosTitle" : "pwa.dockTitle")}</h2>
      </div>
      <ol className="mt-4 space-y-3">
        {steps.map((step, i) => (
          <li key={i} className="flex items-start gap-3 text-sm">
            <span aria-hidden="true" className="grid place-items-center w-6 h-6 shrink-0 rounded-full bg-surface-alt text-xs font-semibold text-text-secondary">{i + 1}</span>
            <span className="min-w-0 pt-0.5">{step}</span>
          </li>
        ))}
      </ol>
      <p className="mt-3 text-xs text-text-muted">{t("pwa.stepsThen")}</p>
      <div className="mt-5 flex justify-end">
        <button ref={done} type="button" data-testid="install-steps-done" onClick={closeInstallSteps}
          className="min-h-11 rounded-lg bg-accent px-4 text-sm font-semibold text-on-accent hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar-bg">
          {t("pwa.gotIt")}
        </button>
      </div>
    </dialog>,
    document.body,
  );
}
