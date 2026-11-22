import { useI18n } from "../contexts/I18nContext";
import { useEngineValue } from "../lib/engineState";

/**
 * What to do about an app with no transport for a group's links (`transport.groupLinks === false`). With Hide my IP on
 * it is the switch (the Linux Desktop with no HyperDHT relay leaves its own Iroh and HyperDHT out for contacts), changed
 * in this app's Settings, Network; otherwise another app.
 */
export function useNoLinksHint(): string {
  const { t } = useI18n();
  const relayOnly = useEngineValue(state => state?.settings.relayOnly === true);
  return t(relayOnly ? "connection.option.relayOnlyHyperdht" : "group.connection.noWebrtcHint");
}
