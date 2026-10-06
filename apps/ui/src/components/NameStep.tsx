import { useEffect, useRef, useState } from "react";
import { knownDeviceGate } from "@ghostly/browser/devices/gate";
import { useI18n } from "../contexts/I18nContext";
import { useSettings } from "../contexts/SettingsContext";
import { JOIN_OPEN_EVENT, DEVICE_LINK_EVENT, deviceLinkOffered } from "../lib/devices";
import { nameStepAllowed, nameStepDone, nameStepPending } from "../lib/nameStep";
import { currentProfile } from "../lib/profiles";
import { DeviceDialog, field, primaryButton } from "./devices/DeviceDialog";

/**
 * "What should people call you?": asked once by a new profile (`lib/nameStep.ts`), on a phone and a wide screen alike.
 * One field, empty, and Skip, which keeps the default: contacts see the anonymous label. Never in a profile with a name
 * already, a restored one, or one this page opened to add to a profile on another device (a device code, or "I already
 * use Ghostly" opened over it, which closes it and asks again on the next start).
 */
export function NameStep() {
  const { t } = useI18n();
  const { settings, updateDefaultNickname } = useSettings();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const input = useRef<HTMLInputElement>(null);

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
  }, [open]);

  if (!open) return null;
  const done = () => { nameStepDone(); setOpen(false); };
  const save = () => {
    const chosen = name.replace(/\s+/g, " ").trim().slice(0, 20);
    if (!chosen) return;
    updateDefaultNickname(chosen);
    done();
  };
  return (
    <DeviceDialog title={t("profile.nameStep.title")} onClose={done} testId="name-step">
      <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); save(); }}>
        <input ref={input} data-testid="name-step-input" aria-label={t("profile.nameStep.title")} className={field} autoFocus maxLength={20}
          placeholder={t("profile.nameStep.placeholder")} value={name} onChange={(event) => setName(event.target.value)} />
        <button type="submit" data-testid="name-step-save" className={primaryButton} disabled={!name.trim()}>{t("profile.nameStep.save")}</button>
        <button type="button" data-testid="name-step-skip" onClick={done}
          className="mx-auto block min-h-10 px-2 text-sm text-text-secondary underline underline-offset-4 hover:text-accent cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded">
          {t("profile.nameStep.skip")}
        </button>
      </form>
    </DeviceDialog>
  );
}
