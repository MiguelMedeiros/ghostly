import { useEffect, useId, useState, useSyncExternalStore, type ReactNode } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import { useI18n } from "../../contexts/I18nContext";
import { reloadIntoGate } from "../../lib/devices";
import { InfoButton } from "../layout/Section";
import { SCREEN_BUTTON, SCREEN_QUIET } from "./DeviceDialog";

/*
 * Limited mode (WISP 06 § When a device checks): the active device of a device set could not read which device is
 * active when it started, so its engine runs with nothing published, dialled, paid or settled until a good read (it
 * reads again every 30 seconds). Before the person sees the app in that state they are asked: "Try again" (start again)
 * or "Start anyway" (the app, offline). Once they went on, a line above the chat list says why nothing goes out.
 */

/** Whether the first state this page got from the engine was limited: a limited start. Later ones (going online) are not. */
let startedLimited: boolean | null = null;
/** "Start anyway" was pressed on this page. */
let goneOn = false;
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  const stop = engine.subscribe(listener);
  return () => { listeners.delete(listener); stop(); };
};

type Limited = "ask" | "on" | null;
function limitedNow(): Limited {
  const state = engine.state;
  if (!state) return null;
  startedLimited ??= !!state.limited;
  if (!state.limited) return null;
  return startedLimited && !goneOn ? "ask" : "on";
}

/** Tests only: a new page. */
export function resetLimitedStart(): void { startedLimited = null; goneOn = false; }

/** Where this page stands with limited mode: asking, on after "Start anyway" (or a check while going online), or off. */
export function useLimited(): Limited {
  return useSyncExternalStore(subscribe, limitedNow);
}

/** The app, or in its place the question a limited start asks first. */
export function LimitedStartGate({ children }: { children: ReactNode }) {
  return useLimited() === "ask" ? <LimitedStart /> : <>{children}</>;
}

/** "Can't check which device is active": Try again starts the app again, Start anyway opens it offline. */
export function LimitedStart() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const id = useId();
  const goOn = () => { goneOn = true; for (const listener of listeners) listener(); };
  return (
    <div role="alertdialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-hint`} data-testid="limited-start" className="h-dvh w-full min-w-0 flex-1 overflow-y-auto bg-chat-bg">
      <div className="mx-auto flex min-h-full w-full max-w-md flex-col justify-center gap-5 px-4 py-8 text-center">
        <div className="space-y-2">
          <div className="text-5xl" aria-hidden="true">👻</div>
          <h1 id={`${id}-title`} data-testid="limited-start-title" className="text-lg font-semibold text-text-primary break-words">{t("devices.limited.title")}</h1>
          <p className="flex items-start justify-center gap-1.5 text-sm text-text-secondary">
            <span id={`${id}-hint`} className="min-w-0 break-words">{t("devices.limited.hint")}</span>
            <InfoButton open={open} onToggle={() => setOpen(!open)} controls={`${id}-info`} testId="limited-start-info" className="mt-px" />
          </p>
          {open && <p id={`${id}-info`} data-testid="limited-start-text" className="rounded-lg bg-surface-hover px-3 py-2 text-start text-xs leading-5 text-text-secondary">{t("devices.limited.info")}</p>}
        </div>
        <div className="flex flex-col items-stretch justify-center gap-2 sm:flex-row sm:items-center">
          <button type="button" autoFocus data-testid="limited-start-retry" onClick={() => void reloadIntoGate()} className={SCREEN_BUTTON}>{t("devices.limited.tryAgain")}</button>
          <button type="button" data-testid="limited-start-go-on" onClick={goOn} className={SCREEN_QUIET}>{t("devices.limited.startAnyway")}</button>
        </div>
      </div>
    </div>
  );
}

/** How long limited mode must last before the line shows: going online checks the turn for a moment every time. */
const BANNER_AFTER_MS = 2_000;

/** Above the chat list while limited mode is on: nothing goes out until Ghostly can check which device is active. */
export function LimitedBanner() {
  const { t } = useI18n();
  const limited = useLimited() === "on";
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!limited) { setShown(false); return; }
    const timer = setTimeout(() => setShown(true), BANNER_AFTER_MS);
    return () => clearTimeout(timer);
  }, [limited]);
  if (!limited || !shown) return null;
  return (
    <div role="status" data-testid="limited-banner" className="shrink-0 border-b border-border bg-surface px-4 py-2 flex items-center gap-2.5">
      <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-yellow-500" />
      <p className="m-0 min-w-0 text-xs text-text-secondary">
        <span className="font-semibold text-text-primary">{t("devices.limited.banner")}</span>
        <span className="text-text-muted"> · {t("devices.limited.bannerHint")}</span>
      </p>
    </div>
  );
}
