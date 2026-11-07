import { useEffect, useRef, useState } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import type { DeviceSetView } from "@ghostly/browser/devices/links";
import { MAX_DEVICES } from "@ghostly/browser/devices/state";
import { useI18n } from "../../contexts/I18nContext";
import { listNamesFor, openJoinAnother, removeErrorKey, useConnectionCheck, useDeviceSet } from "../../lib/devices";
import { usePlatformValue } from "../../hooks/useServicesPlatform";
import { servicesPlatform } from "../../lib/platform";
import { Button, Notice, Row, Section, Switch } from "../wallet/ui";
import { Menu, MenuItem, MenuSeparator } from "../Menu";
import { hasStandby, keepAwakeSupported, useKeepAwakeSetting } from "../../lib/keepAwake";
import { AddDeviceDialog } from "./AddDeviceDialog";
import { DeviceGlyph } from "./DeviceGlyph";
import { HandoffProgress, MoveDialog } from "./Handoff";
import { LostChecklist, RemoveDeviceDialog } from "./RemoveDeviceDialog";
import { RenameDeviceDialog } from "./RenameDeviceDialog";
import { FAILURES, dayText, useHandoffView, walletNameOf } from "../../lib/handoff";
import { nextOf, said } from "../../lib/notices";
import { fillNames } from "../../lib/fillNodes";
import { problemText, type Problem } from "../../lib/problemText";
import { useFocusKept } from "../../hooks/useFocusKept";

/** The refusals that come from this device's wallets (WISP 06 § Wallets). */
const WALLET_REFUSALS = new Set<string>(["wallet", "loading", "mainnet", "expiry", "call"]);
/** A move that stopped on the way, with the profile still here: Try again moves it. */
const STOPPED = new Set<string>(["stalled", "dropped", "damaged"]);

type Device = DeviceSetView["devices"][number];
/** Whether this platform keeps several profiles: joining another device's profile adds one. */
const profilesHere = () => !!servicesPlatform?.features.profiles;

/**
 * Profile, Devices (WISP 06 § User experience): Add a device, then one row per device with what it is and its state
 * (This device · Active, Active, Standby, Not finished, Removed). On the active device a row offers "Move to <device>"
 * while that device is connected, and its menu Check connection, Rename and Remove (this device's own row: Rename). The
 * details are behind the ⓘ marks.
 */
export function DevicesSection() {
  const { t, language } = useI18n();
  const view = useDeviceSet();
  // Drawn again when that changes, not on every engine state.
  const canSwitch = usePlatformValue(profilesHere);
  const [keepAwake, setKeepAwake] = useKeepAwakeSetting();
  const [adding, setAdding] = useState(false);
  const [moving, setMoving] = useState<{ key: string; name: string } | null>(null);
  const [removing, setRemoving] = useState<{ key: string; name: string } | null>(null);
  const [removed, setRemoved] = useState<string | null>(null);
  const [lost, setLost] = useState(false);
  const [secret, setSecret] = useState<{ busy?: boolean; done?: boolean; error?: Problem }>({});
  const newSecret = async () => {
    setSecret({ busy: true });
    try { await engine.call("deviceNewSecret"); setSecret({ done: true }); }
    catch (cause) { const key = removeErrorKey(cause); setSecret({ error: key ? said(key, t) : problemText(cause, t) }); }
  };
  // What the engine refused of "Not now" on the secret offer and of "Let <device> try again": said under each.
  const [refused, setRefused] = useState<{ dismiss?: Problem; allow?: Problem }>({});
  const ask = (which: "dismiss" | "allow", work: Promise<unknown>) => {
    setRefused((was) => ({ ...was, [which]: undefined }));
    void work.catch((cause: unknown) => setRefused((was) => ({ ...was, [which]: problemText(cause, t) })));
  };
  const handoff = useHandoffView(!moving);
  const thisActive = view?.devices.some((device) => device.self && device.active) ?? false;
  // A move under way from this device (WISP 06 § Handoff progress, "on both devices"): one started here whose dialog was
  // closed ("You can keep using Ghostly"), or one the other device started with Use here.
  const running = thisActive && !moving && handoff?.role === "giver" && handoff.step !== "failed" ? handoff : null;
  // Cancel pressed in those steps: once they go, the keyboard focus goes to that device's row, not to the page.
  const [refocus, setRefocus] = useState<string | null>(null);
  const cancelRunning = async (key: string) => { await engine.call("deviceHandoffCancel"); setRefocus(key); };
  // "Let <device> try again" done: its row goes at the next read, and the keyboard focus that was on it goes to that
  // device's row, not to the page.
  const wrongPassword = handoff?.failure === "password" && handoff.role === "giver";
  const [allowed, setAllowed] = useState<string | null>(null);
  useEffect(() => {
    if (!allowed || wrongPassword) return;
    setAllowed(null);
    setRefocus(allowed);
  }, [allowed, wrongPassword]);
  // Remove done: the device's row goes, and the ⋮ that opened the dialog with it. The keyboard focus goes to its Removed row.
  const removedBox = useRef<HTMLDivElement>(null);
  const [focusRemoved, setFocusRemoved] = useState(false);
  useEffect(() => {
    if (!focusRemoved || !removed) return;
    setFocusRemoved(false);
    removedBox.current?.focus();
  }, [focusRemoved, removed]);
  // The Move dialog closed while its move goes on: the focus it gives back to Move to is dropped to the page when Move to
  // goes (no second move is offered while one runs). It goes to the move's steps here instead.
  const [moveClosed, setMoveClosed] = useState(false);
  const runningBox = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!moveClosed || !running) return;
    setMoveClosed(false);
    if (!document.activeElement || document.activeElement === document.body) runningBox.current?.focus();
  }, [moveClosed, running]);
  // The device a Remove here just took out of the set: its row goes in the render that adds its Removed row, not at the
  // next read of the set seconds later, so the list never offers Move to a device it also says is removed. Forgotten
  // once a read of the set no longer has it.
  const [gone, setGone] = useState<string | null>(null);
  const listed = !!gone && !!view?.devices.some((device) => device.key === gone);
  useEffect(() => { if (gone && view && !listed) setGone(null); }, [gone, view, listed]);
  const devices = (view?.devices ?? []).filter((device) => device.key !== gone);
  const { answers: checked, check } = useConnectionCheck(devices);
  const full = devices.length >= MAX_DEVICES;
  // The device a takeover stopped, while it is still in the set: what "Remove <device>" after the offer removes. Found by
  // its key: two devices may have the same name.
  const stopped = view?.secretOffer?.key ? devices.find((device) => !device.self && device.key === view.secretOffer!.key) : undefined;
  const waiting = listNamesFor(view?.waiting?.map((w) => w.name) ?? [], language);
  // The handoff keeps the name the device had when it started: the set has its name after a Rename.
  const handoffDevice = handoff ? devices.find((device) => device.key === handoff.key)?.name || handoff.device : "";
  return (
    <Section title={t("devices.section.title")} testId="profile-devices">
      {/* Four devices, the most a profile has (WISP 06): the button stays, off, and the line says why. */}
      <Row testId={full ? "device-add-full" : undefined} label={t("devices.section.lead")} hint={full ? t("devices.section.full") : t("devices.section.leadHint")}
        info={full ? t("devices.section.fullInfo") : t("devices.section.info")}>
        <Button data-testid="device-add-open" onClick={() => setAdding(true)} disabled={!view || full}>{t("devices.add.button")}</Button>
      </Row>
      {/* The other way round: this device, with a profile from another device. Offered while this profile has no other device. */}
      {canSwitch && view && devices.length <= 1 && !view.foreignSet && (
        <Row testId="device-join-another-row" label={t("devices.join.anotherLead")} info={t("devices.join.anotherInfo")}>
          <Button data-testid="device-join-another-open" onClick={() => openJoinAnother()}>{t("devices.join.anotherButton")}</Button>
        </Row>
      )}
      {/* Where that move stands, with Cancel while nothing has changed yet: the dialog is not the only place that says it. */}
      {running && (
        <div ref={runningBox} tabIndex={-1} data-testid="handoff-running" className="px-4 py-3.5 text-sm focus:outline-none">
          <HandoffProgress view={running} onCancel={() => cancelRunning(running.key)} />
        </div>
      )}
      {devices.map((device) => (
        <DeviceRow key={device.key} device={device} thisActive={thisActive} busy={!!running} checked={checked[device.key]}
          focus={refocus === device.key} onFocused={() => setRefocus(null)}
          onMove={() => { setMoveClosed(false); setMoving({ key: device.key, name: device.name }); }} onCheck={() => void check(device.key)}
          onRemove={() => { setRemoved(null); setRemoving({ key: device.key, name: device.name }); }} />
      ))}
      {view?.unfinishedGrants?.map((grant) => (
        <Row key={grant.key} testId="device-row-unfinished" leading={<DeviceGlyph name={grant.name} />} label={<bdi>{grant.name}</bdi>}
          hint={t("devices.section.unfinished")} info={t("devices.section.unfinishedInfo")} />
      ))}
      {removed && (
        <div ref={removedBox} tabIndex={-1} data-testid="device-removed" className="focus:outline-none">
          <Row leading={<DeviceGlyph name={removed} />} label={<bdi>{removed}</bdi>} hint={t("devices.section.removed")} info={t("devices.remove.doneInfo")} />
        </div>
      )}
      {view?.waiting?.length ? <Row testId="device-waiting" label={fillNames(t("devices.section.waiting", { devices: waiting[0] }), waiting[1])} /> : null}
      {view?.foreignSet && <Row testId="device-foreign-set" label={t("devices.section.foreign")} />}
      {thisActive && view?.secretOffer && (
        <Row testId="device-secret-offer" label={stopped ? fillNames(t("devices.secret.offer"), { device: stopped.name }) : t("devices.secret.offerUnnamed")} info={t("devices.secret.info")}>
          {view.secretOffer.lost && <Button data-testid="device-secret-offer-lost" onClick={() => setLost(true)}>{t("devices.remove.lost")}</Button>}
          {stopped
            ? <Button variant="primary" data-testid="device-secret-offer-remove" onClick={() => setRemoving({ key: stopped.key, name: stopped.name })}>{fillNames(t("devices.secret.removeOffer"), { device: stopped.name })}</Button>
            : <Button variant="primary" data-testid="device-secret-offer-new" disabled={secret.busy} onClick={() => void newSecret()}>{t("devices.secret.button")}</Button>}
          <Button data-testid="device-secret-offer-dismiss" onClick={() => ask("dismiss", engine.call("deviceSecretOfferDismiss"))}>{t("devices.secret.notNow")}</Button>
        </Row>
      )}
      {thisActive && view?.secretOffer && refused.dismiss && <div className="px-4 py-3"><Notice problem={refused.dismiss} testId="device-secret-offer-error" /></div>}
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
          {secret.error && <Notice problem={secret.error} testId="device-secret-error" />}
        </div>
      )}
      {/* "Let <device> try again" only once that device is refused (15 with no success, WISP 06 § Authorizing a handoff):
          before that, pressing it would start its count again before any limit. */}
      {wrongPassword && (
        <Row testId="handoff-wrong-password" label={fillNames(t("devices.handoff.wrongPassword"), { device: handoffDevice })}>
          {handoff.refused && <Button data-testid="handoff-allow" onClick={() => ask("allow", engine.call("deviceHandoffAllow", { key: handoff.key }).then(() => setAllowed(handoff.key)))}>{fillNames(t("devices.handoff.allowAgain"), { device: handoffDevice })}</Button>}
        </Row>
      )}
      {wrongPassword && refused.allow &&<div className="px-4 py-3"><Notice problem={refused.allow} testId="handoff-allow-error" /></div>}
      {/* A move whose copy stopped (WISP 06 § Handoff progress, Failures): the profile is still here; Try again moves it. */}
      {thisActive && handoff?.role === "giver" && handoff.step === "failed" && handoff.failure && STOPPED.has(handoff.failure) && (() => {
        const name = handoffDevice || t("devices.join.otherDevice");
        return (
          <Row testId="handoff-stopped" label={fillNames(t(FAILURES[handoff.failure]), { device: name })} hint={fillNames(nextOf(FAILURES[handoff.failure], t), { device: name })}>
            <Button data-testid="handoff-try-again" onClick={() => setMoving({ key: handoff.key, name })}>{t("devices.handoff.tryAgain")}</Button>
          </Row>
        );
      })()}
      {/* A pull this device's wallets or a call on it kept from happening: what keeps the profile here (WISP 06 § Wallets). */}
      {handoff?.role === "giver" && handoff.step === "failed" && handoff.failure && WALLET_REFUSALS.has(handoff.failure) && (
        <Row testId="handoff-wallet-refusal" label={t(FAILURES[handoff.failure], { device: handoffDevice, wallet: walletNameOf(handoff.wallet) })}
          hint={handoff.expiresAt !== undefined ? t("devices.handoff.staysExpires", { wallet: walletNameOf(handoff.wallet), date: dayText(handoff.expiresAt, language) }) : nextOf(FAILURES[handoff.failure], t)} />
      )}
      {adding && <AddDeviceDialog onClose={() => setAdding(false)} />}
      {moving && <MoveDialog device={moving.name} deviceKey={moving.key} onClose={() => { setMoving(null); setMoveClosed(true); }} />}
      {removing && <RemoveDeviceDialog device={removing.name} deviceKey={removing.key} onClose={() => setRemoving(null)} onRemoved={() => { setGone(removing.key); setRemoved(removing.name); setFocusRemoved(true); }} />}
      {lost && <LostChecklist device={stopped?.name} onClose={() => setLost(false)} onRemove={stopped ? () => { setLost(false); setRemoving({ key: stopped.key, name: stopped.name }); } : undefined} />}
    </Section>
  );
}

/**
 * One device: its mark, its name, its state and, for another device, whether its link is connected. "Move to
 * <device>" stays on the row, the main thing to do with a device; the rest is in its menu. While a move runs (`busy`)
 * neither another move nor Rename nor Remove is offered: the engine would refuse them, and the move's Cancel is right
 * above. Rename opens its dialog from the row, and the focus comes back to the ⋮ when it closes.
 * `focus`: a move to this device was cancelled from the section, and once it no longer runs the keyboard focus that was
 * on Cancel comes here (Move to, else the menu).
 */
function DeviceRow({ device, thisActive, busy, checked, focus, onFocused, onMove, onCheck, onRemove }: {
  device: Device; thisActive: boolean; busy: boolean; checked?: string; focus?: boolean; onFocused?(): void; onMove(): void; onCheck(): void; onRemove(): void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  // The name just saved, shown until the set read next says it (the section reads it every few seconds).
  const [renamed, setRenamed] = useState<string | null>(null);
  useEffect(() => setRenamed(null), [device.name]);
  const name = renamed ?? device.name;
  const anchor = useRef<HTMLDivElement>(null);
  const move = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLButtonElement>(null);
  // The link drops while Move to, or a ⋮ that holds only Check connection, has the keyboard focus: they go, and the
  // focus goes to what is left on the row (its ⋮, else the row), not to the page. Not for a move that starts: the
  // section gives that focus to the move's steps. The Row takes no ref: its box is found from the link's state in it.
  const rowBox = useRef<HTMLElement | null>(null);
  useFocusKept(rowBox, () => !busy && menu.current);
  const live = device.status === "live";
  const state = device.self ? (device.active ? t("devices.section.thisActive") : t("devices.section.thisStandby"))
    : device.active ? t("devices.section.active") : t("devices.section.standby");
  const canMove = !device.self && live && thisActive && !busy;
  const canCheck = !device.self && live;
  const canRemove = !device.self && thisActive && !busy;
  // Only the active device writes the set's record, so only it renames: any device, itself included (WISP 06 § Record).
  const canRename = thisActive && !busy;
  // The dialog closed: the focus goes back to the ⋮ that opened it, not to the page.
  const wasRenaming = useRef(false);
  useEffect(() => {
    if (wasRenaming.current && !renaming) menu.current?.focus();
    wasRenaming.current = renaming;
  }, [renaming]);
  useEffect(() => {
    if (!focus || busy) return;
    onFocused?.();
    if (!document.activeElement || document.activeElement === document.body) (move.current ?? menu.current)?.focus();
  }, [focus, busy, onFocused]);
  const menuLabel = t("devices.section.menu", { device: name });
  return (
    <Row testId="device-row" leading={<DeviceGlyph name={name} active={device.active} />} label={<bdi>{name}</bdi>}
      hint={<>
        <span data-testid="device-state">{state}</span>
        {!device.self && <>
          <span aria-hidden="true"> · </span>
          <span ref={(node) => { rowBox.current = node?.closest<HTMLElement>("[data-testid=device-row]") ?? null; }} data-testid="device-link-status" data-status={device.status ?? "none"} className="inline-flex items-center gap-1">
            <span aria-hidden="true" className={`inline-block h-1.5 w-1.5 rounded-full ${live ? "bg-accent" : "bg-text-muted"}`} />
            {live ? t("devices.section.live") : t("devices.section.connecting")}
          </span>
        </>}
        {checked && <span data-testid="device-check-result" role="status" className="block">{checked}</span>}
      </>}>
      {canMove && <Button ref={move} data-testid="device-move" onClick={onMove}>{fillNames(t("devices.handoff.moveTo"), { device: name })}</Button>}
      {(canCheck || canRename || canRemove) && (
        <div ref={anchor} className="relative">
          <button ref={menu} type="button" data-testid={device.self ? "device-menu-self" : "device-menu"} aria-haspopup="true" aria-expanded={open} aria-label={menuLabel} title={menuLabel} onClick={() => setOpen((was) => !was)}
            className="grid h-10 w-10 max-md:h-11 max-md:w-11 cursor-pointer place-items-center rounded-lg text-text-secondary hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="12" cy="19" r="2" /></svg>
          </button>
          <Menu open={open} onClose={() => setOpen(false)} anchorRef={anchor} testId="device-menu-items" label={menuLabel} focusFirst>
            {canCheck && <MenuItem testId="device-check" onClick={() => { setOpen(false); onCheck(); }}>{t("devices.section.check")}</MenuItem>}
            {canRename && <MenuItem testId="device-rename-open" onClick={() => { setOpen(false); setRenaming(true); }}>{t("devices.rename.button")}</MenuItem>}
            {(canCheck || canRename) && canRemove && <MenuSeparator />}
            {canRemove && <MenuItem testId="device-remove-open" danger onClick={() => { setOpen(false); onRemove(); }}>{t("devices.remove.button")}</MenuItem>}
          </Menu>
        </div>
      )}
      {renaming && <RenameDeviceDialog device={name} deviceKey={device.key} onClose={() => setRenaming(false)} onRenamed={setRenamed} />}
    </Row>
  );
}
