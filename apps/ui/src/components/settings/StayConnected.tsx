import { useI18n } from "../../contexts/I18nContext";
import { openAppSettings } from "../../desktop/androidCameraRefusal";
import { useStayConnectedSetting, useStoppedInBackground } from "../../lib/stayConnected";
import { Row } from "../layout";
import { Button, Switch } from "../wallet/ui";

/**
 * Notifications → Stay connected in the background (the Android app, lib/stayConnected): on unless turned off, with
 * what it costs in battery. Once Android ended the app under it, the row says so too, with the app's settings
 * (Battery → Unrestricted) a tap away.
 */
export function StayConnectedRow() {
  const { t } = useI18n();
  const [on, setOn] = useStayConnectedSetting();
  const stopped = useStoppedInBackground();
  const label = t("settings.stayConnected");
  return (
    <Row label={label} testId="settings-stay-connected-row"
      hint={<span role="status" data-testid="settings-stay-connected-hint">{t(stopped ? "settings.stayConnectedStoppedHint" : "settings.stayConnectedHint")}</span>}>
      {stopped && <Button data-testid="settings-stay-connected-open-settings" onClick={() => void openAppSettings()}>{t("settings.noticesOpenSettings")}</Button>}
      <Switch testId="settings-stay-connected" label={label} checked={on} onChange={setOn} />
    </Row>
  );
}
