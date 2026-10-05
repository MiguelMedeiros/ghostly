import { useEffect, useId, useRef, useState } from "react";
import { readDeviceInvite } from "@ghostly/core";
import { useI18n, type TranslationKey } from "../../contexts/I18nContext";
import { DEVICE_LINK_EVENT, JOIN_OPEN_EVENT, failureKey, joinInNewProfile, takeDeviceLink, takeJoinRequest, type JoinOpen } from "../../lib/devices";
import { errorText } from "../../lib/errorText";
import { servicesPlatform } from "../../lib/platform";
import { activeProfileId, listProfiles } from "../../lib/profiles";
import { listSessions } from "../../lib/storage";
import { InfoButton } from "../layout/Section";
import { DeviceDialog, primaryButton, quietButton } from "./DeviceDialog";
import { JoinProfileDialog } from "./JoinProfileDialog";

/**
 * Where "Add this device to my profile" opens (WISP 06 § User experience), over whatever the app shows: the chat list
 * on a phone, the home pane on a wide screen, or the standby screen. It opens:
 * - on "I already use Ghostly" (`openJoinProfile`), in this profile;
 * - in a profile made to join (`joinInNewProfile`), once it starts;
 * - on "Add this device to another profile" (`openJoinAnother`), which asks first;
 * - on a device code opened as a link (`takeDeviceLinkFromAddress`): straight in on a fresh install (one profile, no
 *   chat), else it asks first, and the code goes into a new profile, never into one the person uses.
 * A code the engine refuses in this profile because it is in use (it holds a group, an identity or money, not only
 * chats) goes the same way: on to "Add this device to another profile", with the code kept.
 */
export function JoinHost({ standby = false }: { standby?: boolean }) {
  const { t } = useI18n();
  const [open, setOpen] = useState<JoinOpen | null>(() => {
    const request = standby ? null : takeJoinRequest(activeProfileId());
    return request ? { kind: "join", request } : null;
  });
  const [invalid, setInvalid] = useState<TranslationKey | null>(null);

  useEffect(() => {
    const onOpen = (event: Event) => setOpen((event as CustomEvent<JoinOpen>).detail);
    const onLink = () => {
      const code = takeDeviceLink();
      if (!code) return;
      const reading = readDeviceInvite(code);
      if (!reading.ok) { setInvalid(failureKey(reading.reason)); return; }
      const fresh = !standby && listProfiles().length === 1 && listSessions().length === 0;
      setOpen(fresh ? { kind: "join", request: { code, start: "name" } } : { kind: "another", code });
    };
    window.addEventListener(JOIN_OPEN_EVENT, onOpen);
    window.addEventListener(DEVICE_LINK_EVENT, onLink);
    // A link taken before this mounted (the address is read first, the lock asked after).
    onLink();
    return () => { window.removeEventListener(JOIN_OPEN_EVENT, onOpen); window.removeEventListener(DEVICE_LINK_EVENT, onLink); };
  }, [standby]);

  useEffect(() => {
    if (!invalid) return;
    const timer = setTimeout(() => setInvalid(null), 6000);
    return () => clearTimeout(timer);
  }, [invalid]);

  const close = () => setOpen(null);
  return <>
    {invalid && (
      <div role="alert" data-testid="device-link-invalid" onClick={() => setInvalid(null)}
        className="fixed top-3 left-1/2 -translate-x-1/2 z-[60] max-w-[calc(100%_-_2rem)] rounded-lg border border-border bg-panel-header px-4 py-2 text-sm text-danger shadow-xl cursor-pointer">
        {t(invalid)}
      </div>
    )}
    {open?.kind === "join" && (
      <JoinProfileDialog code={open.request.code} start={open.request.start} onClose={close}
        onRestore={() => { close(); window.location.hash = "#/profile"; }}
        // A good code read in a profile that is in use here: it goes into a new profile, asked first, as a link's does.
        // An app with one profile only has nowhere else to put it, and says why it cannot.
        onInUse={servicesPlatform?.features.profiles ? (code) => setOpen({ kind: "another", code }) : undefined} />
    )}
    {open?.kind === "another" && <JoinAnotherDialog code={open.code} onClose={close} />}
  </>;
}

/**
 * "Add this device to another profile": a new, empty profile here opens on "Add this device to my profile" (with the
 * code a link carried); the profiles here stay as they are. The code says nothing of the device that made it, so the
 * question names none.
 */
export function JoinAnotherDialog({ code, onClose }: { code?: string; onClose(): void }) {
  const { t } = useI18n();
  const id = useId();
  const [more, setMore] = useState(false);
  const [error, setError] = useState("");
  // Continue has the focus, so Enter goes on: the dialog, opened after this mounts, would give it to the close button.
  const primary = useRef<HTMLButtonElement>(null);
  useEffect(() => { const timer = setTimeout(() => primary.current?.focus()); return () => clearTimeout(timer); }, []);
  const go = () => {
    try { joinInNewProfile(t("devices.join.profileName"), { code, start: "name" }); }
    catch (cause) { setError(errorText(cause, t)); }
  };
  return (
    <DeviceDialog title={code ? t("devices.join.linkTitle") : t("devices.join.another")} onClose={onClose} testId="device-join-another">
      <div className="flex items-start gap-2">
        <p className="flex-1 text-text-secondary">{t("devices.join.newHere")}</p>
        <InfoButton open={more} onToggle={() => setMore(!more)} controls={id} testId="device-join-another-info" />
      </div>
      {more && <p id={id} className="text-xs text-text-secondary leading-relaxed ps-3 border-s-2 border-border">{code ? t("devices.join.linkInfo") : t("devices.join.anotherInfo")}</p>}
      {error && <p role="alert" className="text-danger">{error}</p>}
      <button type="button" ref={primary} data-testid="device-join-another-go" onClick={go} className={primaryButton}>{t("devices.join.go")}</button>
      <button type="button" data-testid="device-join-another-cancel" onClick={onClose} className={quietButton}>{t("common.cancel")}</button>
    </DeviceDialog>
  );
}
