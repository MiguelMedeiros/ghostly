import { useState } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import { useI18n } from "../../contexts/I18nContext";
import { useDeviceSet } from "../../lib/devices";
import { Button, Row, Section } from "../wallet/ui";
import { AddDeviceDialog } from "./AddDeviceDialog";
import { MoveDialog } from "./Handoff";
import { useHandoffView } from "../../lib/handoff";

/**
 * Profile, Devices (WISP 06 § User experience): the devices of this profile, which one is active, and Add a device.
 * Plain in this part: Move, Rename and Remove come with the parts that do them.
 */
export function DevicesSection() {
  const { t } = useI18n();
  const view = useDeviceSet();
  const [adding, setAdding] = useState(false);
  const [moving, setMoving] = useState<{ key: string; name: string } | null>(null);
  const handoff = useHandoffView(!moving);
  const thisActive = view?.devices.some((device) => device.self && device.active) ?? false;
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
            {thisActive && <Button data-testid="device-move" onClick={() => setMoving({ key: device.key, name: device.name })}>{t("devices.handoff.moveTo", { device: device.name })}</Button>}
            <Button data-testid="device-check" onClick={() => void check(device.key)}>{t("devices.section.check")}</Button>
            {checked[device.key] && <span data-testid="device-check-result" className="text-xs text-text-muted">{checked[device.key]}</span>}
          </>}
        </Row>
      ))}
      {view?.unfinishedGrants?.map((grant) => (
        <Row key={grant.key} testId="device-row-unfinished" label={grant.name} hint={t("devices.section.unfinished")} info={t("devices.section.unfinishedInfo")} />
      ))}
      {handoff?.failure === "password" && handoff.role === "giver" && (
        <Row testId="handoff-wrong-password" label={t("devices.handoff.wrongPassword", { device: handoff.device })}>
          <Button data-testid="handoff-allow" onClick={() => void engine.call("deviceHandoffAllow", { key: handoff.key })}>{t("devices.handoff.allowAgain", { device: handoff.device })}</Button>
        </Row>
      )}
      {adding && <AddDeviceDialog onClose={() => setAdding(false)} />}
      {moving && <MoveDialog device={moving.name} deviceKey={moving.key} onClose={() => setMoving(null)} />}
    </Section>
  );
}
