import { useState, useSyncExternalStore } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import { useI18n } from "../contexts/I18nContext";

const subscribe = (listener: () => void) => engine.subscribe(listener);
const reconnectingNow = () => engine.reconnecting;

/**
 * Says once, to a screen reader, that a tab which said "Reconnecting…" (ReconnectingBanner) is connected to Ghostly
 * again: the banner goes with nothing said. Mounted once over every page, so a phone's hidden list does not keep it
 * quiet. Nothing at the first connection, and the line clears when the tab is lost again, to be said anew.
 */
export function ReconnectedSaid() {
  const { t } = useI18n();
  const reconnecting = useSyncExternalStore(subscribe, reconnectingNow);
  const [was, setWas] = useState(reconnecting);
  const [back, setBack] = useState(false);
  if (was !== reconnecting) {
    setWas(reconnecting);
    setBack(!reconnecting);
  }
  return <p className="sr-only" aria-live="polite" data-testid="reconnected-said">{back ? t("pwa.reconnected") : ""}</p>;
}
