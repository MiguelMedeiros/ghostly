import { useState } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import { useI18n } from "../../contexts/I18nContext";
import { useDeviceSet } from "../../lib/devices";
import { Button, Row, Section } from "../wallet/ui";
import { AddDeviceDialog } from "./AddDeviceDialog";

/**
 * Profile, Devices (WISP 06 § User experience): the devices of this profile, which one is active, and Add a device.
 * Plain in this part: Move, Rename and Remove come with the parts that do them.
 */
export function DevicesSection() {
  const { t } = useI18n();
  const view = useDeviceSet();
  const [adding, setAdding] = useState(false);
  const [checked, setChecked] = useState<Record<string, string>>({});
  const check = async (key: string) => {
    setChecked((was) => ({ ...was, [key]: "…" }));
    try {
      const { ms } = await engine.call("devicePing", { key });
      setChecked((was) => ({ ...was, [key]: t("devices.section.answered", { ms: Math.max(1, Math.round(ms)) }) }));
    } catch { setChecked((was) => ({ ...was, [key]: t("devices.section.noAnswer") })); }
  };
  const devices = view?.devices ?? [];
  return (
    <Section title={t("devices.section.title")} testId="profile-devices">
      <Row label={t("devices.section.title")} hint={t("devices.section.hint")} info={t("devices.section.info")}>
        <Button data-testid="device-add-open" onClick={() => setAdding(true)} disabled={!view || devices.length >= 4}>{t("devices.add.button")}</Button>
      </Row>
      {devices.map((device) => (
        <Row key={device.key} testId="device-row" label={device.name}
          hint={device.self ? (device.active ? t("devices.section.thisActive") : t("devices.section.thisStandby")) : device.active ? t("devices.section.active") : t("devices.section.standby")}
          value={device.self ? undefined : <span data-testid="device-link-status" data-status={device.status ?? "none"}>{device.status === "live" ? t("devices.section.live") : t("devices.section.connecting")}</span>}>
          {!device.self && device.status === "live" && <>
            <Button data-testid="device-check" onClick={() => void check(device.key)}>{t("devices.section.check")}</Button>
            {checked[device.key] && <span data-testid="device-check-result" className="text-xs text-text-muted">{checked[device.key]}</span>}
          </>}
        </Row>
      ))}
      {adding && <AddDeviceDialog onClose={() => setAdding(false)} />}
    </Section>
  );
}
