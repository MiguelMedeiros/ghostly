import { useEffect, useState } from "react";
import { readDeviceInvite } from "@ghostly/core";
import { useI18n, type TranslationKey } from "../../contexts/I18nContext";
import { DEVICE_LINK_EVENT, JOIN_OPEN_EVENT, failureKey, takeDeviceLink, takeJoinRequest, type JoinRequest } from "../../lib/devices";
import { activeProfileId } from "../../lib/profiles";
import { JoinProfileDialog } from "./JoinProfileDialog";

/**
 * Where "Add this device to my profile" opens (WISP 06 § User experience), over whatever the app shows: the chat list
 * on a phone, the home pane on a wide screen, or the standby screen. It opens:
 * - on "I already use Ghostly" (`openJoinProfile`), at its first step;
 * - on "Add this device to another profile" (`openJoinAnother`), at the scanner;
 * - on a device code opened as a link (`takeDeviceLinkFromAddress`), or read by Join on the chat list, at the one
 *   screen "Add this phone to <profile>", in whatever profile this is: the dialog makes a new profile for the code
 *   when this one holds something, never puts it into one in use;
 * - in a profile made for a code (`joinInNewProfile`), once it starts, straight on to the digits.
 * Each opening replaces the last: a second code read while one shows takes its place.
 */
export function JoinHost({ standby = false }: { standby?: boolean }) {
  const { t } = useI18n();
  const [open, setOpen] = useState<{ request: JoinRequest; key: number } | null>(() => {
    const request = standby ? null : takeJoinRequest(activeProfileId());
    return request ? { request, key: 0 } : null;
  });
  const [invalid, setInvalid] = useState<TranslationKey | null>(null);

  useEffect(() => {
    const show = (request: JoinRequest) => setOpen((last) => ({ request, key: (last?.key ?? 0) + 1 }));
    const onOpen = (event: Event) => show((event as CustomEvent<{ request: JoinRequest }>).detail.request);
    const onLink = () => {
      const link = takeDeviceLink();
      if (!link) return;
      const reading = readDeviceInvite(link.code);
      if (!reading.ok) { setInvalid(failureKey(reading.reason)); return; }
      show({ code: link.code, ...(link.profile ? { profile: link.profile } : {}) });
    };
    window.addEventListener(JOIN_OPEN_EVENT, onOpen);
    window.addEventListener(DEVICE_LINK_EVENT, onLink);
    // A link taken before this mounted (the address is read first, the lock asked after).
    onLink();
    return () => { window.removeEventListener(JOIN_OPEN_EVENT, onOpen); window.removeEventListener(DEVICE_LINK_EVENT, onLink); };
  }, []);

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
    {open && (
      <JoinProfileDialog key={open.key} request={open.request} standby={standby} onClose={close}
        onRestore={() => { close(); window.location.hash = "#/profile"; }} />
    )}
  </>;
}
