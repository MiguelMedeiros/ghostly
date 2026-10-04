import { useRef, useState } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import type { DeviceSetView } from "@ghostly/browser/devices/links";
import { useI18n } from "../../contexts/I18nContext";
import { errorText } from "../../lib/errorText";
import { listNames, removeErrorKey, useDeviceSet } from "../../lib/devices";
import { Button, Notice, Row, Section, Switch } from "../wallet/ui";
import { Menu, MenuItem, MenuSeparator } from "../Menu";
import { hasStandby, keepAwakeSupported, useKeepAwakeSetting } from "../../lib/keepAwake";
import { AddDeviceDialog } from "./AddDeviceDialog";
import { DeviceGlyph } from "./DeviceGlyph";
import { MoveDialog } from "./Handoff";
import { LostChecklist, RemoveDeviceDialog } from "./RemoveDeviceDialog";
import { FAILURES, dayText, useHandoffView, walletNameOf } from "../../lib/handoff";

/** The refusals that come from this device's wallets (WISP 06 § Wallets). */
const WALLET_REFUSALS = new Set<string>(["wallet", "loading", "mainnet", "expiry"]);
/** A move that stopped on the way, with the profile still here: Try again moves it. */
const STOPPED = new Set<string>(["stalled", "dropped"]);

type Device = DeviceSetView["devices"][number];

/**
 * Profile, Devices (WISP 06 § User experience): Add a device, then one row per device with what it is and its state
 * (This device · Active, Active, Standby, Not finished, Removed). On the active device a row offers "Move to <device>"
 * while that device is connected, and its menu Check connection and Remove. The details are behind the ⓘ marks.
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
    setChecked((was) => ({ ...was, [key]: t("devices.section.checking") }));
    try {
      const { ms } = await engine.call("devicePing", { key });
      setChecked((was) => ({ ...was, [key]: t("devices.section.answered", { ms: Math.max(1, Math.round(ms)) }) }));
    } catch { setChecked((was) => ({ ...was, [key]: t("devices.section.noAnswer") })); }
  };
  const devices = view?.devices ?? [];
  // The device a takeover stopped, while it is still in the set: what "Remove <device>" after the offer removes.
  const stopped = view?.secretOffer?.device ? devices.find((device) => !device.self && device.name === view.secretOffer!.device) : undefined;
  return (
    <Section title={t("devices.section.title")} testId="profile-devices">
      <Row label={t("devices.section.lead")} hint={t("devices.section.leadHint")} info={t("devices.section.info")}>
        <Button data-testid="device-add-open" onClick={() => setAdding(true)} disabled={!view || devices.length >= 4}>{t("devices.add.button")}</Button>
      </Row>
      {devices.map((device) => (
        <DeviceRow key={device.key} device={device} thisActive={thisActive} checked={checked[device.key]}
          onMove={() => setMoving({ key: device.key, name: device.name })} onCheck={() => void check(device.key)}
          onRemove={() => { setRemoved(null); setRemoving({ key: device.key, name: device.name }); }} />
      ))}
      {view?.unfinishedGrants?.map((grant) => (
        <Row key={grant.key} testId="device-row-unfinished" leading={<DeviceGlyph name={grant.name} />} label={grant.name}
          hint={t("devices.section.unfinished")} info={t("devices.section.unfinishedInfo")} />
      ))}
      {removed && (
        <Row testId="device-removed" leading={<DeviceGlyph name={removed} />} label={removed}
          hint={t("devices.section.removed")} info={t("devices.remove.doneInfo")} />
      )}
      {view?.waiting?.length ? <Row testId="device-waiting" label={t("devices.section.waiting", { devices: listNames(view.waiting.map((w) => w.name), language) })} /> : null}
      {view?.foreignSet && <Row testId="device-foreign-set" label={t("devices.section.foreign")} />}
      {thisActive && view?.secretOffer && (
        <Row testId="device-secret-offer" label={view.secretOffer.device ? t("devices.secret.offer", { device: view.secretOffer.device }) : t("devices.secret.offerUnnamed")} info={t("devices.secret.info")}>
          {view.secretOffer.lost && <Button data-testid="device-secret-offer-lost" onClick={() => setLost(true)}>{t("devices.remove.lost")}</Button>}
          {stopped
            ? <Button variant="primary" data-testid="device-secret-offer-remove" onClick={() => setRemoving({ key: stopped.key, name: stopped.name })}>{t("devices.secret.removeOffer", { device: stopped.name })}</Button>
            : <Button variant="primary" data-testid="device-secret-offer-new" disabled={secret.busy} onClick={() => void newSecret()}>{t("devices.secret.button")}</Button>}
          <Button data-testid="device-secret-offer-dismiss" onClick={() => void engine.call("deviceSecretOfferDismiss")}>{t("devices.secret.notNow")}</Button>
        </Row>
      )}
      {/* On a Desktop with a standby device (WISP 06 § User experience): this device's own switch, never the profile's. */}
      {keepAwakeSupported() && hasStandby(view) && (
        <Row label={t("devices.section.keepAwake")} info={t("devices.section.keepAwakeHint")} testId="device-keep-awake">
          <Switch checked={keepAwake} onChange={setKeepAwake} label={t("devices.section.keepAwake")} testId="device-keep-awake-switch" />
        </Row>
      )}
      {thisActive && devices.length > 1 && (
        <Row label={t("devices.secret.button")} hint={t("devices.secret.hint")} info={t("devices.secret.info")} testId="device-secret">
          <Button data-testid="device-secret-new" disabled={secret.busy} onClick={() => void newSecret()}>{t("devices.secret.make")}</Button>
        </Row>
      )}
      {(secret.done || secret.error) && (
        <div className="px-4 py-3">
          {secret.done && <Notice tone="success" testId="device-secret-done">{t("devices.secret.done")}</Notice>}
          {secret.error && <Notice tone="error" testId="device-secret-error">{secret.error}</Notice>}
        </div>
      )}
      {handoff?.failure === "password" && handoff.role === "giver" && (
        <Row testId="handoff-wrong-password" label={t("devices.handoff.wrongPassword", { device: handoff.device })}>
          <Button data-testid="handoff-allow" onClick={() => void engine.call("deviceHandoffAllow", { key: handoff.key })}>{t("devices.handoff.allowAgain", { device: handoff.device })}</Button>
        </Row>
      )}
      {/* A move whose copy stopped (WISP 06 § Handoff progress, Failures): the profile is still here; Try again moves it. */}
      {thisActive && handoff?.role === "giver" && handoff.step === "failed" && handoff.failure && STOPPED.has(handoff.failure) && (() => {
        const name = devices.find((device) => device.key === handoff.key)?.name || handoff.device || t("devices.join.otherDevice");
        return (
          <Row testId="handoff-stopped" label={t(FAILURES[handoff.failure], { device: name })}>
            <Button data-testid="handoff-try-again" onClick={() => setMoving({ key: handoff.key, name })}>{t("devices.handoff.tryAgain")}</Button>
          </Row>
        );
      })()}
      {/* A pull this device's wallets kept from happening: what keeps the profile here (WISP 06 § Wallets). */}
      {handoff?.role === "giver" && handoff.step === "failed" && handoff.failure && WALLET_REFUSALS.has(handoff.failure) && (
        <Row testId="handoff-wallet-refusal" label={t(FAILURES[handoff.failure], { device: handoff.device, wallet: walletNameOf(handoff.wallet) })}
          hint={handoff.expiresAt !== undefined ? t("devices.handoff.staysExpires", { wallet: walletNameOf(handoff.wallet), date: dayText(handoff.expiresAt, language) }) : undefined} />
      )}
      {adding && <AddDeviceDialog onClose={() => setAdding(false)} />}
      {moving && <MoveDialog device={moving.name} deviceKey={moving.key} onClose={() => setMoving(null)} />}
      {removing && <RemoveDeviceDialog device={removing.name} deviceKey={removing.key} onClose={() => setRemoving(null)} onRemoved={() => setRemoved(removing.name)} />}
      {lost && <LostChecklist device={stopped?.name} onClose={() => setLost(false)} onRemove={stopped ? () => { setLost(false); setRemoving({ key: stopped.key, name: stopped.name }); } : undefined} />}
    </Section>
  );
}

/**
 * One device: its mark, its name, its state and, for another device, whether its link is connected. "Move to
 * <device>" stays on the row, the main thing to do with a device; the rest is in its menu.
 */
function DeviceRow({ device, thisActive, checked, onMove, onCheck, onRemove }: {
  device: Device; thisActive: boolean; checked?: string; onMove(): void; onCheck(): void; onRemove(): void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const live = device.status === "live";
  const state = device.self ? (device.active ? t("devices.section.thisActive") : t("devices.section.thisStandby"))
    : device.active ? t("devices.section.active") : t("devices.section.standby");
  const canMove = !device.self && live && thisActive;
  const canCheck = !device.self && live;
  const canRemove = !device.self && thisActive;
  const menuLabel = t("devices.section.menu", { device: device.name });
  return (
    <Row testId="device-row" leading={<DeviceGlyph name={device.name} active={device.active} />} label={device.name}
      hint={<>
        <span data-testid="device-state">{state}</span>
        {!device.self && <>
          <span aria-hidden="true"> · </span>
          <span data-testid="device-link-status" data-status={device.status ?? "none"} className="inline-flex items-center gap-1">
            <span aria-hidden="true" className={`inline-block h-1.5 w-1.5 rounded-full ${live ? "bg-accent" : "bg-text-muted"}`} />
            {live ? t("devices.section.live") : t("devices.section.connecting")}
          </span>
        </>}
        {checked && <span data-testid="device-check-result" role="status" className="block">{checked}</span>}
      </>}>
      {canMove && <Button data-testid="device-move" onClick={onMove}>{t("devices.handoff.moveTo", { device: device.name })}</Button>}
      {(canCheck || canRemove) && (
        <div ref={anchor} className="relative">
          <button type="button" data-testid="device-menu" aria-haspopup="true" aria-expanded={open} aria-label={menuLabel} title={menuLabel} onClick={() => setOpen((was) => !was)}
            className="grid h-10 w-10 max-md:h-11 max-md:w-11 cursor-pointer place-items-center rounded-lg text-text-secondary hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="12" cy="19" r="2" /></svg>
          </button>
          <Menu open={open} onClose={() => setOpen(false)} anchorRef={anchor} testId="device-menu-items" label={menuLabel} focusFirst>
            {canCheck && <MenuItem testId="device-check" onClick={() => { setOpen(false); onCheck(); }}>{t("devices.section.check")}</MenuItem>}
            {canCheck && canRemove && <MenuSeparator />}
            {canRemove && <MenuItem testId="device-remove-open" danger onClick={() => { setOpen(false); onRemove(); }}>{t("devices.remove.button")}</MenuItem>}
          </Menu>
        </div>
      )}
    </Row>
  );
}
