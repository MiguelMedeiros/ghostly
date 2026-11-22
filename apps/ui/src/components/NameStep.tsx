import { useEffect, useId, useState } from "react";
import { knownDeviceGate } from "@ghostly/browser/devices/gate";
import { useI18n } from "../contexts/I18nContext";
import { useSettings } from "../contexts/SettingsContext";
import { JOIN_OPEN_EVENT, DEVICE_LINK_EVENT, deviceLinkOffered } from "../lib/devices";
import { useFittedNameField } from "../hooks/useGroupNameField";
import { nameStepAllowed, nameStepDone, nameStepPending } from "../lib/nameStep";
import { OWN_NAME_LENGTH, cleanOwnName, fitsOwnName } from "../lib/ownName";
import { closedByArrival } from "../lib/layerHistory";
import { currentProfile } from "../lib/profiles";
import { touchOnly } from "../lib/touchOnly";
import { DeviceDialog, field, primaryButton } from "./devices/DeviceDialog";

/**
 * Where the focus goes once the step closes. It opened as the app started, with nothing focused before it, so the
 * dialog gives the focus back to the page's body. Over a chat (an invite link opens one) its message field, or on a
 * touch screen, where that brings up the keyboard, its back button (a phone's header); else New, the first thing a new
 * person does, where the page shows it; else the page's main area. Only what is on screen: a phone keeps the chat list,
 * New in it, mounted but hidden under an open chat, where focus() does nothing. Never away from something that took
 * the focus in the meantime.
 */
function focusAfter() {
  const active = document.activeElement;
  if (active && active !== document.body) return;
  const places = [...(touchOnly() ? [] : ["textarea.composer-textarea:not([disabled])"]), "[data-testid='chat-back']", "[data-testid='sidebar-new-chat']", "main[tabindex]"];
  for (const place of places) {
    for (const next of document.querySelectorAll<HTMLElement>(place)) {
      if (next.closest("[hidden], [inert]") || !(next.checkVisibility?.() ?? true)) continue;
      next.focus();
      if (document.activeElement === next) return;
    }
  }
}

/**
 * "What should people call you?": asked once by a new profile (`lib/nameStep.ts`), on a phone and a wide screen alike.
 * One field, empty, and Skip, which keeps the default: contacts see the anonymous label. Never in a profile with a name
 * already, a restored one, or one this page opened to add to a profile on another device (a device code, or "I already
 * use Ghostly" opened over it, which closes it and asks again on the next start).
 *
 * It says what a name may be: the limit under the field (its description), a keystroke past it once in a polite status
 * (`full`, said again only after a delete), and, while the name is blank or only invisible characters, why Continue
 * is off, under the field and as the button's description (a disabled button with a reason, as Take over does).
 */
export function NameStep() {
  const { t } = useI18n();
  const { settings, updateDefaultNickname } = useSettings();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const id = useId();
  // Whether the last keystroke or paste had no room: said once, until a delete makes room again. Room is counted by the
  // name's own rule (one more letter fits), never in UTF-16 units; a change the hook cut says so after this (`onDropped`).
  const [full, setFull] = useState(false);
  const keep = (next: string) => { if (fitsOwnName(next + "a")) setFull(false); setName(next); };
  // Counted in characters as seen, never cut inside an emoji (`fitsOwnName`): no `maxLength`, which counts UTF-16 units.
  const nameField = useFittedNameField(name, keep, fitsOwnName, () => setFull(true));
  const input = nameField.ref;

  useEffect(() => {
    if (!nameStepPending() || settings.defaultNickname.trim() || currentProfile().restored || deviceLinkOffered() || knownDeviceGate()?.full === false) return;
    let live = true;
    void nameStepAllowed().then((allowed) => { if (live && allowed && !deviceLinkOffered()) setOpen(true); });
    const away = () => setOpen(false);
    window.addEventListener(JOIN_OPEN_EVENT, away);
    window.addEventListener(DEVICE_LINK_EVENT, away);
    return () => { live = false; window.removeEventListener(JOIN_OPEN_EVENT, away); window.removeEventListener(DEVICE_LINK_EVENT, away); };
    // Asked when the page starts: a name typed later in Profile is not a reason to open it again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The dialog's showModal puts the focus on its close button, after the field's own autofocus: the field takes it back.
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => input.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open, input]);

  if (!open) return null;
  const done = () => { nameStepDone(); setOpen(false); requestAnimationFrame(focusAfter); };
  // A link that reaches this page (another tab's, the installed app's launch) is no answer: it stays over the chat the
  // link opens, as on a first visit with the link, and Back has an entry to close it again (`useBackCloses`).
  const close = () => { if (!closedByArrival()) done(); };
  const chosen = cleanOwnName(name);
  const save = () => {
    if (!chosen) return;
    updateDefaultNickname(chosen);
    done();
  };
  return (
    <DeviceDialog title={t("profile.nameStep.title")} onClose={close} testId="name-step">
      <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); save(); }}>
        <div className="space-y-1">
          <input ref={input} data-testid="name-step-input" aria-label={t("profile.nameStep.title")} aria-describedby={`${id}-limit`} className={field} autoFocus
            placeholder={t("profile.nameStep.placeholder")} value={name} onChange={nameField.onChange}
            onCompositionStart={nameField.onCompositionStart} onCompositionEnd={nameField.onCompositionEnd} dir={nameField.dir} />
          <p id={`${id}-limit`} data-testid="name-step-limit" className="text-xs text-text-muted">{t("profile.nameStep.limit", { count: OWN_NAME_LENGTH })}</p>
          {!chosen && <p id={`${id}-why`} data-testid="name-step-why" className="text-xs text-text-muted">{t("profile.nameStep.needName")}</p>}
        </div>
        {/* Mounted empty with the step, so the cut is news a screen reader hears when it is written in. */}
        <p role="status" data-testid="name-step-full" className="sr-only">{full ? t("profile.nameStep.full", { count: OWN_NAME_LENGTH }) : ""}</p>
        <button type="submit" data-testid="name-step-save" className={primaryButton} disabled={!chosen} aria-describedby={chosen ? undefined : `${id}-why`}>{t("profile.nameStep.save")}</button>
        <button type="button" data-testid="name-step-skip" onClick={done}
          className="mx-auto block min-h-10 px-2 text-sm text-text-secondary underline underline-offset-4 hover:text-accent cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded">
          {t("profile.nameStep.skip")}
        </button>
      </form>
    </DeviceDialog>
  );
}
