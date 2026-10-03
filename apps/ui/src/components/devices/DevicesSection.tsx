import { useState } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import { useI18n } from "../../contexts/I18nContext";
import { errorText } from "../../lib/errorText";
import { listNames, removeErrorKey, useDeviceSet } from "../../lib/devices";
import { Button, Notice, Row, Section, Switch } from "../wallet/ui";
import { hasStandby, keepAwakeSupported, useKeepAwakeSetting } from "../../lib/keepAwake";
import { AddDeviceDialog } from "./AddDeviceDialog";
import { MoveDialog } from "./Handoff";
import { LostChecklist, RemoveDeviceDialog } from "./RemoveDeviceDialog";
import { FAILURES, dayText, useHandoffView, walletNameOf } from "../../lib/handoff";

/** The refusals that come from this device's wallets (WISP 06 § Wallets). */
const WALLET_REFUSALS = new Set<string>(["wallet", "loading", "mainnet", "expiry"]);

/**
 * Profile, Devices (WISP 06 § User experience): the devices of this profile, which one is active, Add a device, Move,
 * Remove, and New device secret. Plain on purpose: Rename and the final design come with later parts.
 */
export function DevicesSection() {
  const { t, language } = useI18n();
  const view = useDeviceSet();
  const [keepAwake, setKeepAwake] = useKeepAwakeSetting();
  const [adding, setAdding] = useState(false);
  const [moving, setMoving] = useState<{ key: string; name: string } | null>(null);
  const [removing, setRemoving] = useState<{ key: string; name: string } | null>(null);
  const [removed, setRemoved] = useState<string | null>(null);
  const [lost, setLost] = useState(false);
  const [secret, setSecret] = useState<{ busy?: boolean; done?: boolean; error?: string }>({});
  const newSecret = async () => {
    setSecret({ busy: true });
    try { await engine.call("deviceNewSecret"); setSecret({ done: true }); }
    catch (cause) { const key = removeErrorKey(cause); setSecret({ error: key ? t(key) : errorText(cause, t) }); }
  };
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
          {!device.self && thisActive && <Button data-testid="device-remove-open" onClick={() => { setRemoved(null); setRemoving({ key: device.key, name: device.name }); }}>{t("devices.remove.button")}</Button>}
        </Row>
      ))}
      {removed && <Row testId="device-removed" label={t("devices.remove.done", { device: removed })} />}
      {view?.waiting?.length ? <Row testId="device-waiting" label={t("devices.section.waiting", { devices: listNames(view.waiting.map((w) => w.name), language) })} /> : null}
      {view?.foreignSet && <Row testId="device-foreign-set" label={t("devices.section.foreign")} />}
      {thisActive && view?.secretOffer && (
        <Row testId="device-secret-offer" label={view.secretOffer.device ? t("devices.secret.offer", { device: view.secretOffer.device }) : t("devices.secret.offerUnnamed")}>
          {view.secretOffer.lost && <Button data-testid="device-secret-offer-lost" onClick={() => setLost(true)}>{t("devices.remove.lost")}</Button>}
          {(() => {
            const stopped = view.secretOffer?.device ? devices.find((device) => !device.self && device.name === view.secretOffer!.device) : undefined;
            return stopped
              ? <Button data-testid="device-secret-offer-remove" onClick={() => setRemoving({ key: stopped.key, name: stopped.name })}>{t("devices.secret.removeOffer", { device: stopped.name })}</Button>
              : <Button data-testid="device-secret-offer-new" disabled={secret.busy} onClick={() => void newSecret()}>{t("devices.secret.button")}</Button>;
          })()}
          <Button data-testid="device-secret-offer-dismiss" onClick={() => void engine.call("deviceSecretOfferDismiss")}>{t("devices.secret.notNow")}</Button>
        </Row>
      )}
      {/* On a Desktop with a standby device (WISP 06 § User experience): this device's own switch, never the profile's. */}
      {keepAwakeSupported() && hasStandby(view) && (
        <Row label={t("devices.section.keepAwake")} hint={t("devices.section.keepAwakeHint")} testId="device-keep-awake">
          <Switch checked={keepAwake} onChange={setKeepAwake} label={t("devices.section.keepAwake")} testId="device-keep-awake-switch" />
        </Row>
      )}
      {thisActive && devices.length > 1 && (
        <Row label={t("devices.secret.button")} hint={t("devices.secret.hint")} info={t("devices.secret.info")} testId="device-secret">
          <Button data-testid="device-secret-new" disabled={secret.busy} onClick={() => void newSecret()}>{t("devices.secret.button")}</Button>
        </Row>
      )}
      {secret.done && <Notice tone="success" testId="device-secret-done">{t("devices.secret.done")}</Notice>}
      {secret.error && <Notice tone="error" testId="device-secret-error">{secret.error}</Notice>}
      {view?.unfinishedGrants?.map((grant) => (
        <Row key={grant.key} testId="device-row-unfinished" label={grant.name} hint={t("devices.section.unfinished")} info={t("devices.section.unfinishedInfo")} />
      ))}
      {handoff?.failure === "password" && handoff.role === "giver" && (
        <Row testId="handoff-wrong-password" label={t("devices.handoff.wrongPassword", { device: handoff.device })}>
          <Button data-testid="handoff-allow" onClick={() => void engine.call("deviceHandoffAllow", { key: handoff.key })}>{t("devices.handoff.allowAgain", { device: handoff.device })}</Button>
        </Row>
      )}
      {/* A pull this device's wallets kept from happening: what keeps the profile here (WISP 06 § Wallets). */}
      {handoff?.role === "giver" && handoff.step === "failed" && handoff.failure && WALLET_REFUSALS.has(handoff.failure) && (
        <Row testId="handoff-wallet-refusal" label={t(FAILURES[handoff.failure], { device: handoff.device, wallet: walletNameOf(handoff.wallet) })}
          hint={handoff.expiresAt !== undefined ? t("devices.handoff.staysExpires", { wallet: walletNameOf(handoff.wallet), date: dayText(handoff.expiresAt, language) }) : undefined} />
      )}
      {adding && <AddDeviceDialog onClose={() => setAdding(false)} />}
      {moving && <MoveDialog device={moving.name} deviceKey={moving.key} onClose={() => setMoving(null)} />}
      {removing && <RemoveDeviceDialog device={removing.name} deviceKey={removing.key} onClose={() => setRemoving(null)} onRemoved={() => setRemoved(removing.name)} />}
      {lost && (() => {
        // After the checklist, the device that stopped is removed, when it is still in the set.
        const stopped = view?.secretOffer?.device ? devices.find((device) => !device.self && device.name === view.secretOffer!.device) : undefined;
        return <LostChecklist device={stopped?.name} onClose={() => setLost(false)} onRemove={stopped ? () => { setLost(false); setRemoving({ key: stopped.key, name: stopped.name }); } : undefined} />;
      })()}
    </Section>
  );
}
