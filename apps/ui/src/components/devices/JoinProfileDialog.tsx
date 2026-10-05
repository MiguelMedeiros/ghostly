import { useEffect, useRef, useState } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import { getBrowserHost } from "@ghostly/browser/host";
import type { EnrollView } from "@ghostly/browser/devices/enroll";
import { askPersistentStorage, isIosBrowserTab } from "@ghostly/browser/devices/install";
import { readDeviceInvite } from "@ghostly/core";
import { useI18n, type TranslationKey } from "../../contexts/I18nContext";
import {
  defaultDeviceName, deviceNoun, enrollErrorKey, enrollInUse, enrollLoading, failureKey, joinInNewProfile, readDeviceLink, reloadIntoGate, type JoinRequest,
} from "../../lib/devices";
import { errorText } from "../../lib/errorText";
import { isDesktopApp } from "../../lib/externalLink";
import { servicesPlatform } from "../../lib/platform";
import { JoinDialog } from "../JoinDialog";
import { Notice } from "../wallet/ui";
import { DeviceDialog, Digits, InfoLine, Status, field, primaryButton, quietButton } from "./DeviceDialog";

/** How long a profile whose wallets are still loading is asked again before the join gives up and says why. */
const LOADING_WAIT_MS = 60_000;
/** The done screen stays this long before the standby screen opens by itself. */
const DONE_PAUSE_MS = 1_500;

/** "Add this phone to <profile>" and "Add this phone to your profile", by what this device is. */
const TITLES: Record<ReturnType<typeof deviceNoun>, { named: TranslationKey; yours: TranslationKey }> = {
  phone: { named: "devices.join.title.phone", yours: "devices.join.titleYours.phone" },
  tablet: { named: "devices.join.title.tablet", yours: "devices.join.titleYours.tablet" },
  computer: { named: "devices.join.title.computer", yours: "devices.join.titleYours.computer" },
};

type Step = "choose" | "scan" | "confirm" | "home" | "enroll";
/** Whether the code may go into this profile: here, a new profile for it, not known yet, or nowhere (an app of one profile). */
type Place = "here" | "new" | "loading" | "nowhere";

/**
 * Adding this device to a profile, on the new device (WISP 06 § User experience). Every route to a device code ends on
 * one screen: the camera opening the link, Join on the chat list, "I already use Ghostly", "Add this device to another
 * profile", a paste. That screen says which profile ("Add this phone to <profile>"), has the device's name to change,
 * and one button. When this profile holds something (`deviceEnrollReady`, and the engine's own refusal on join), the
 * button makes a new profile for the code and goes on there by itself (`start: "go"`), with the lock already passed in
 * this tab; this profile stays as it is. Then the digits, and then the standby screen.
 *
 * On an iPhone or iPad tab it says to add Ghostly to the Home Screen first, in three steps: a tab keeps other storage.
 */
export function JoinProfileDialog({ request = {}, standby = false, onClose, onRestore }: { request?: JoinRequest; standby?: boolean; onClose(): void; onRestore(): void }) {
  const { t } = useI18n();
  const tab = isIosBrowserTab();
  const canMakeProfiles = !!servicesPlatform?.features.profiles;
  const [step, setStep] = useState<Step>(() => {
    if (tab) return request.code || request.start ? "home" : "choose";
    if (request.code && request.start === "go") return "enroll";
    if (request.code) return "confirm";
    return request.start === "scan" ? "scan" : "choose";
  });
  // The code, and the profile its link names: from the request, or from the scanner.
  const [code, setCode] = useState(request.code);
  const [profile, setProfile] = useState(request.profile);
  const [name, setName] = useState(() => request.name ?? defaultDeviceName(isDesktopApp() ? { userAgent: navigator.userAgent, desktop: true } : undefined));
  const [place, setPlace] = useState<Place | null>(null);
  const [view, setView] = useState<EnrollView | null>(null);
  const [kept, setKept] = useState<boolean | null>(null);
  const [preparing, setPreparing] = useState(false);
  // What went wrong before the engine had an enrollment to show: said, with a way to a new code.
  const [failure, setFailure] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const ended = useRef(true);
  const closed = useRef(false);
  const started = useRef(false);
  // The scanner opened from the first step goes back there; opened by itself, it closes the dialog.
  const fromChoose = useRef(false);
  const noun = deviceNoun(isDesktopApp() ? { userAgent: "" } : undefined);

  useEffect(() => { closed.current = false; return () => { closed.current = true; }; }, []);

  // Where the code goes, asked when the one screen shows: a standby, or a profile that holds something, makes a new one.
  useEffect(() => {
    if (step !== "confirm") return;
    if (standby) { setPlace("new"); return; }
    let live = true;
    setPlace(null);
    engine.call("deviceEnrollReady").then((ready) => {
      if (!live) return;
      setPlace(ready === "ready" ? "here" : ready === "loading" ? "loading" : canMakeProfiles ? "new" : "nowhere");
    }, () => { if (live) setPlace("here"); });
    return () => { live = false; };
  }, [step, standby, canMakeProfiles]);

  // While an enrollment runs, its state is read twice a second.
  useEffect(() => {
    if (step !== "enroll" || !view || ended.current) return;
    const timer = setInterval(() => void engine.call("deviceEnrollView").then((next) => {
      if (!next) return;
      ended.current = next.step === "done" || next.step === "failed" || next.step === "unfinished";
      setView(next);
    }, () => {}), 500);
    return () => clearInterval(timer);
  }, [step, view]);
  useEffect(() => () => { if (!ended.current) void engine.call("deviceEnrollCancel").catch(() => {}); }, []);

  // Done: the standby screen opens by itself, unless the browser may clear the data, which the person reads first.
  useEffect(() => {
    if (view?.step !== "done" || kept === false) return;
    const timer = setTimeout(() => void reloadIntoGate({ keepUnlocked: true }), DONE_PAUSE_MS);
    return () => clearTimeout(timer);
  }, [view?.step, kept]);

  /** A new profile for the code, which goes on to the digits by itself; this profile stays as it is. */
  const goNew = (device: string) => {
    try {
      setBusy(true);
      joinInNewProfile(profile || t("devices.join.profileName"), { code: device, start: "go", name: name.trim(), ...(profile ? { profile } : {}) });
    } catch (cause) { setBusy(false); setError(errorText(cause, t)); }
  };

  /** Joins in this profile, asking again while its wallets load; refused for this profile, the code goes to a new one. */
  const join = async (device: string) => {
    setStep("enroll"); setFailure(""); setError("");
    setKept(await askPersistentStorage());
    const until = Date.now() + LOADING_WAIT_MS;
    for (;;) {
      try {
        const first = await engine.call("deviceEnrollJoin", { code: device, name: name.trim(), app: getBrowserHost().version });
        if (closed.current) { void engine.call("deviceEnrollCancel").catch(() => {}); return; }
        ended.current = false;
        setPreparing(false); setView(first);
        return;
      } catch (cause) {
        if (closed.current) return;
        if (enrollLoading(cause) && Date.now() < until) {
          setPreparing(true);
          await new Promise((resolve) => setTimeout(resolve, 1_500));
          if (closed.current) return;
          continue;
        }
        setPreparing(false);
        if (enrollInUse(cause) && canMakeProfiles && request.start !== "go") { goNew(device); return; }
        const key = enrollErrorKey(cause);
        setFailure(key ? t(key) : errorText(cause, t));
        return;
      }
    }
  };

  // A profile made for the code goes on at once: the person pressed Add already.
  useEffect(() => {
    if (step !== "enroll" || started.current || !code || view) return;
    started.current = true;
    void join(code);
  // Once, on opening; later joins come from the person's button.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const add = () => {
    if (!code || !name.trim() || busy) return;
    setError("");
    const reading = readDeviceInvite(code);
    if (!reading.ok) { setError(t(failureKey(reading.reason))); return; }
    if (place === "nowhere") { setError(t("devices.fail.inUse")); return; }
    started.current = true;
    if (place === "new") { goNew(code); return; }
    void join(code);
  };

  /** A new code, read in the scanner: the old one is spent or refused. */
  const scanAgain = () => { setView(null); setFailure(""); setError(""); setCode(undefined); ended.current = true; started.current = false; fromChoose.current = false; setStep("scan"); };

  if (step === "scan") {
    return <JoinDialog
      onDevice={async (value) => { const link = readDeviceLink(value); setCode(link.code); setProfile(link.profile); setError(""); setStep("confirm"); }}
      onClose={() => { if (fromChoose.current) setStep("choose"); else onClose(); }} />;
  }

  const close = () => { if (view?.step === "done" || view?.step === "unfinished") void reloadIntoGate({ keepUnlocked: true }); else onClose(); };
  const titles = TITLES[noun];
  const title = step === "choose" ? t("devices.join.already")
    : step === "home" ? t("devices.join.homeTitle")
      : profile ? t(titles.named, { profile }) : t(titles.yours);
  return (
    <DeviceDialog title={title} onClose={close} testId="device-join">
      {step === "choose" && <>
        {tab ? <HomeScreenSteps code={false} />
          : <button type="button" data-testid="device-join-add" onClick={() => { fromChoose.current = true; setStep("scan"); }} className={primaryButton}>{t("devices.join.addThis")}</button>}
        <button type="button" data-testid="device-join-restore" onClick={onRestore} className={quietButton}>{t("devices.join.restore")}</button>
      </>}
      {step === "home" && <HomeScreenSteps code={!!request.code} />}
      {step === "confirm" && (
        <form className="space-y-3" data-testid="device-join-confirm" data-place={place ?? undefined} data-profile={profile || undefined} onSubmit={(event) => { event.preventDefault(); add(); }}>
          <label className="block space-y-1">
            <span className="text-text-secondary">{t("devices.join.name")}</span>
            <input data-testid="device-join-name" maxLength={16} value={name} onChange={(event) => setName(event.target.value)} className={field} />
          </label>
          {place === "new" && <InfoLine testId="device-join-new-profile" info={t("devices.join.newProfileInfo")}>{t("devices.join.newProfile")}</InfoLine>}
          {error && <p role="alert" data-testid="device-join-error" className="text-danger">{error}</p>}
          <button type="submit" autoFocus data-testid="device-join-next" disabled={!name.trim() || busy} className={primaryButton}>{t("devices.join.add")}</button>
        </form>
      )}
      {step === "enroll" && <>
        {!view && !failure && <Status testId="device-join-connecting" step={preparing ? "preparing" : "connecting"}>{preparing ? t("devices.join.preparing") : t("devices.join.connecting")}</Status>}
        {failure && <>
          <p role="alert" data-testid="device-join-error" className="text-danger">{failure}</p>
          <button type="button" data-testid="device-join-scan-again" onClick={scanAgain} className={primaryButton}>{t("devices.join.scanAgain")}</button>
        </>}
        {view?.role === "joiner" && <>
          {view.step === "connecting" && <Status testId="device-join-connecting" step="connecting">{t("devices.join.connecting")}</Status>}
          {view.step === "confirm" && <>
            <p className="text-text-primary">{t("devices.join.check")}</p>
            <Digits digits={view.digits} testId="device-join-digits" />
            <Status>{t("devices.join.confirmOn")}</Status>
          </>}
          {view.step === "finishing" && <Status>{t("devices.join.finishing")}</Status>}
          {(view.step === "done" || view.step === "unfinished") && <>
            <p data-testid="device-join-done" data-step={view.step} className="text-text-primary">{view.step === "done" ? t("devices.join.done") : t("devices.join.unfinished")}</p>
            {kept === false && <Notice tone="warning" testId="device-join-persist">{t("devices.join.persist", { device: view.device || t("devices.join.otherDevice") })}</Notice>}
            {view.step === "done" && kept !== false
              ? <Status>{t("devices.join.opening")}</Status>
              : <button type="button" data-testid="device-join-continue" onClick={() => void reloadIntoGate({ keepUnlocked: true })} className={primaryButton}>{t("devices.join.continue")}</button>}
          </>}
          {view.step === "failed" && <>
            <p role="alert" data-testid="device-join-failed" data-reason={view.reason} className="text-danger">{t(failureKey(view.reason))}</p>
            <button type="button" data-testid="device-join-scan-again" onClick={scanAgain} className={primaryButton}>{t("devices.join.scanAgain")}</button>
          </>}
        </>}
      </>}
    </DeviceDialog>
  );
}

/**
 * The Home Screen step on an iPhone or iPad tab, as three short steps. The app on the Home Screen has storage of its
 * own and opens at its start page, so the code does not go with it: it is scanned again there (`code`: one was read).
 */
function HomeScreenSteps({ code }: { code: boolean }) {
  const { t } = useI18n();
  return (
    <div data-testid="device-join-home-screen" className="space-y-3">
      <InfoLine info={t("devices.join.homeScreenInfo")}>{t("devices.join.homeScreenWhy")}</InfoLine>
      <ol className="list-decimal ps-5 space-y-1.5 text-text-primary">
        <li>{t("devices.join.homeStep1")}</li>
        <li>{t("devices.join.homeStep2")}</li>
        <li>{code ? t("devices.join.homeStep3Code") : t("devices.join.homeStep3")}</li>
      </ol>
    </div>
  );
}
