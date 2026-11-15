import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { endOtherCalls, otherCallOn, setCallOn } from "@ghostly/react";
import type { GroupView } from "@ghostly/browser/shared/types";
import { useI18n } from "../contexts/I18nContext";
import { useSettings } from "../contexts/SettingsContext";
import { useBackCloses, useBackdropDismiss, useQuestionDialog } from "../hooks/useDismiss";
import { groupCallRelayConfig, NO_CALL_KEY, NO_SEALING, useGroupCall, type GroupCallSeal, type LivekitModule } from "../hooks/useGroupCall";
import { useGroupCallSupport } from "../hooks/useGroupCallSupport";
import { useHandler } from "../hooks/useHandler";
import { useCallService } from "../lib/callService";
import { askGroupCallPass, groupCallOf, groupCallProblem, PASS_REFRESH_LEAD_S, passRefreshInMs, type GroupCallPass } from "../lib/groupCallPass";
import { focus } from "../lib/connection";
import { askGroupCallKey, canSealCallMedia, groupCallSealed, groupCallSealProblem } from "../lib/groupCallPass";
import { useEngineValue } from "../lib/engineState";
import { working } from "../lib/focus";
import { authorName } from "../lib/groups";
import type { Problem } from "../lib/problemText";
import { InfoButton } from "./layout/Section";
import { GroupCallView } from "./GroupCallView";
import { Notice } from "./ui/Notice";

/** A refresh the node did not answer is asked again this much later, while the pass still holds. */
const REFRESH_RETRY_MS = 30_000;
/** A sealed call's key not yet here for the epoch the group names (its secret on the way) is asked again this often, so many times. */
const KEY_RETRY_MS = 2_000;
const KEY_RETRIES = 15;

/**
 * The group's call nodes (`${groupId} ${sfu}`) this app, while open, was told to join with "Hide my IP from contacts"
 * on: it asks once each, and again for another node the admin names.
 */
const joinedShowingIp = new Set<string>();

/**
 * Join call in the header of a group with a call node (WISP 602): asks the node for a pass, joins its room
 * (`useGroupCall`) and opens the call's window. One call at a time: on a 1:1 call, it asks to end that one first; a
 * 1:1 call answered while this one is on ends it (`callRegistry`). Where this app cannot join a group call (the Linux
 * Desktop, `useGroupCallSupport`), it shows off, with an ⓘ saying where to join from.
 */
export function GroupCallButton({ group, loadLivekit }: { group: GroupView; loadLivekit?: () => Promise<LivekitModule> }) {
  const { t } = useI18n();
  const groupId = group.id;
  const ipShownTo = `${groupId} ${group.call?.sfu ?? ""}`;
  const id = useId();
  const [key] = useState(() => Symbol("group call"));
  /** The pass the room was joined with: it stays while in the room, since a new token would leave and join again. */
  const [joined, setJoined] = useState<GroupCallPass | null>(null);
  /**
   * The newest pass, asked again before it runs out, for joining again after a drop without asking the node. Only while
   * the group's node is still the one it came from: the admin naming another one makes the next Join call ask that one.
   */
  const held = useRef<{ pass: GroupCallPass; until: number; sfu: string | undefined } | null>(null);
  const sfu = groupCallOf(group)?.sfu;
  const sfuNow = useRef(sfu);
  sfuNow.current = sfu;
  const [asking, setAsking] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [askEnd, setAskEnd] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  // "Hide my IP from contacts": the call goes through the node's TURN server only, once the person agreed to the node
  // seeing this device's IP; a node that gives no TURN server leaves Join call off.
  const relayOnly = useEngineValue((state) => state?.settings.relayOnly === true);
  const [askIp, setAskIp] = useState(false);
  const [noRelay, setNoRelay] = useState(false);
  const support = useGroupCallSupport();
  // A group whose call is sealed end to end (WISP 602): joined only with its key, never unsealed; a browser that
  // can't seal call media leaves Join call off, and says why.
  const sealed = groupCallSealed(group);
  const [canSeal] = useState(canSealCallMedia);
  const unsealable = sealed && !canSeal;
  const [seal, setSeal] = useState<GroupCallSeal | null>(null);
  const blocked = !support.supported || (relayOnly && noRelay) || unsealable;
  const noRelayProblem: Problem = { tone: "error", title: t("calls.group.noRelay"), info: t("calls.group.noRelayInfo") };
  const noSealingProblem = groupCallSealProblem(NO_SEALING, t)!;
  const unsupported: Problem | null = support.reason === null ? null : { tone: "error", title: support.reason };
  const call = useGroupCall({ url: joined?.url ?? "", token: joined?.token ?? "", iceServers: joined?.iceServers, relayOnly, e2ee: sealed ? seal : undefined, loadLivekit });
  /** The group's call key for its newest epoch, before a sealed join; says why when it isn't here. */
  const takeKey = async (): Promise<boolean> => {
    setAsking(true);
    const key = await askGroupCallKey(groupId).catch(() => null).finally(() => setAsking(false));
    setSeal(key);
    if (!key) setProblem(groupCallSealProblem(NO_CALL_KEY, t));
    return !!key;
  };

  useEffect(() => { if (!relayOnly) setNoRelay(false); }, [relayOnly]);

  const hold = (pass: GroupCallPass, from: string | undefined) => { held.current = { pass, until: Date.now() + pass.expiresIn * 1000, sfu: from }; };
  const enter = (pass: GroupCallPass) => {
    // A 1:1 call answered while the pass was asked for: it ends first, as on pressing Join call, the pass kept for it.
    if (otherCallOn(key)) return setAskEnd(true);
    if (!relayOnly || groupCallRelayConfig(pass.iceServers).iceServers?.length) return setJoined(pass);
    setNoRelay(true);
    setProblem(noRelayProblem);
  };
  const join = useHandler(async () => {
    setProblem(null);
    if (unsealable) return setProblem(noSealingProblem);
    if (sealed && !(await takeKey())) return;
    const kept = held.current;
    if (kept && kept.sfu === sfu && kept.until - Date.now() > PASS_REFRESH_LEAD_S * 1000) return enter(kept.pass);
    setAsking(true);
    try {
      const from = sfu;
      const pass = await askGroupCallPass(groupId);
      hold(pass, from);
      enter(pass);
    } catch (cause) {
      setProblem(groupCallProblem(cause, t));
    } finally {
      setAsking(false);
    }
  });
  const leave = useHandler(() => {
    setJoined(null);
    void call.leave();
  });
  const go = () => {
    if (otherCallOn(key)) setAskEnd(true);
    else void join();
  };
  // Pressed while in the call (its small window leaves the header in reach): the window opens whole again. Joining
  // anew would take the newer pass held, so the room was left and joined again in front of everyone.
  const [raised, setRaised] = useState(0);
  const press = () => {
    if (asking) return;
    if (joined) return setRaised((n) => n + 1);
    if (unsupported) return setProblem(problem ? null : unsupported);
    if (blocked) return setProblem(unsealable ? noSealingProblem : noRelayProblem);
    if (relayOnly && !joinedShowingIp.has(ipShownTo)) setAskIp(true);
    else go();
  };
  // Not believed from the node: each tile is named by the group's roster, a key outside it said to be so.
  const inGroup = (identity: string) => group.members.some((m) => m.key === identity);
  const nameOf = (identity: string) => inGroup(identity) ? authorName(group, identity, t) : t("calls.group.notMember", { key: identity.slice(-6) });
  // Only the group's admin moderates its call; the node checks it again on its roster.
  const moderator = group.isAdmin ? { groupId, inGroup } : undefined;

  useEffect(() => {
    if (!joined) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const ask = async () => {
      try {
        const from = sfuNow.current;
        const pass = await askGroupCallPass(groupId);
        if (!live) return;
        hold(pass, from);
        timer = setTimeout(ask, passRefreshInMs(pass.expiresIn));
      } catch {
        if (live) timer = setTimeout(ask, REFRESH_RETRY_MS);
      }
    };
    timer = setTimeout(ask, passRefreshInMs(joined.expiresIn));
    return () => { live = false; clearTimeout(timer); };
  }, [joined, groupId]);

  // A sealed call follows the group's epoch: each new one's key goes into the room (WISP 602 § End-to-end encryption).
  // The group's view can name the epoch a moment before its secret is here: the key is asked again until it is, and
  // once more when the view says the epoch can be read (`canSend`), however late its secret came after the retries.
  const epoch = group.epoch;
  const readable = group.canSend;
  useEffect(() => {
    if (!joined || !sealed) return;
    let live = true, tries = 0;
    let timer: ReturnType<typeof setTimeout>;
    const ask = async () => {
      const key = await askGroupCallKey(groupId).catch(() => null);
      if (!live) return;
      if (key) setSeal((had) => (had?.epoch === key.epoch ? had : key));
      if ((!key || (epoch !== undefined && key.epoch < epoch)) && ++tries < KEY_RETRIES) timer = setTimeout(ask, KEY_RETRY_MS);
    };
    void ask();
    return () => { live = false; clearTimeout(timer); };
  }, [joined, sealed, epoch, readable, groupId]);

  // On the app's calls while in the room: a 1:1 call answered meanwhile ("End and answer") leaves it.
  const on = !!joined && (call.status === "connecting" || call.status === "connected");
  useEffect(() => {
    if (!on) return;
    setCallOn(key, leave);
    return () => setCallOn(key, null);
  }, [on, key, leave]);

  // The Android app keeps the call going out of sight, as a 1:1 call (lib/callService.ts): from the microphone first
  // on (Android 14 and up start a microphone service only with its permission granted) to the call's end, muted or
  // not, since from the background Android would refuse to start it again. No group's name while the app lock is on.
  const { settings } = useSettings();
  const [heard, setHeard] = useState(false);
  useEffect(() => { if (!on) setHeard(false); else if (call.local.mic) setHeard(true); }, [on, call.local.mic]);
  useCallService(on && heard ? { name: group.name || t("group.chat.unnamed"), video: call.local.camera } : null, leave,
    settings.lockScreen.enabled && !!settings.lockScreen.passwordHash);

  // The room closed (the node dropped you) or would not take you: the window goes, and a failed join says why.
  useEffect(() => {
    if (call.status === "failed") setProblem(groupCallSealProblem(call.error?.message, t, call.error?.cause) ?? groupCallProblem(call.error?.cause ?? call.error?.message, t));
    if (call.status === "failed" || call.status === "left") setJoined(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only the status moving there ends it
  }, [call.status]);

  const canShareScreen = typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getDisplayMedia === "function";
  return (
    <div className="relative flex shrink-0 items-center">
      <button ref={button} type="button" onClick={press} {...working(asking)} {...(blocked && { "aria-disabled": true })} data-testid="group-call-join"
        title={t("calls.group.join")} aria-label={t("calls.group.join")} aria-describedby={problem ? `${id}-problem` : undefined}
        className={`flex cursor-pointer items-center justify-center rounded-full p-2 text-text-secondary transition-colors hover:bg-surface-hover hover:text-accent aria-disabled:opacity-40 max-md:h-[44px] max-md:w-[44px] max-md:p-0 ${focus}`}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M23 7l-7 5 7 5V7z" /><rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
        </svg>
      </button>
      {unsupported && <InfoButton open={!!problem} onToggle={press} controls={`${id}-problem`} testId="group-call-unsupported-info" />}
      {/* On a phone Join call is not the header's last button: from its edge the box ran past the screen's side. It
          lies across the width under the header there, as the connection panels do. */}
      {problem && <div id={`${id}-problem`} data-testid="group-call-problem" className="absolute end-0 top-full max-md:fixed max-md:inset-x-2 max-md:top-[calc(3.5rem_+_env(safe-area-inset-top))] max-md:w-auto z-40 mt-2 w-[min(18rem,calc(100vw-1rem))] rounded-xl border border-border bg-panel-header p-3 shadow-xl">
        <Notice problem={problem} testId="group-call-problem-notice" />
        <div className="mt-2 flex justify-end gap-2 text-xs">
          <button type="button" onClick={() => { setProblem(null); button.current?.focus(); }} className={`min-h-8 rounded-md px-2 text-text-secondary hover:bg-surface-hover max-md:min-h-11 ${focus}`}>{t("common.close")}</button>
          {!blocked && <button type="button" onClick={() => void join()} data-testid="group-call-retry" className={`min-h-8 rounded-md px-2 font-semibold text-accent hover:bg-surface-hover max-md:min-h-11 ${focus}`}>{t("calls.group.retry")}</button>}
        </div>
      </div>}
      {joined && <GroupCallView call={call} groupName={group.name || t("group.chat.unnamed")} canShareScreen={canShareScreen} nameOf={nameOf} raised={raised} moderator={moderator}
        onToggleMic={() => void call.toggleMic()} onToggleCamera={() => void call.toggleCamera()} onToggleScreen={() => void call.toggleScreen()} onLeave={leave} />}
      {askIp && <HideIpDialog onClose={() => setAskIp(false)} onConfirm={() => { setAskIp(false); joinedShowingIp.add(ipShownTo); go(); }} />}
      {askEnd && <EndOtherCallDialog onClose={() => setAskEnd(false)} onConfirm={() => { setAskEnd(false); endOtherCalls(key); void join(); }} />}
    </div>
  );
}

/** "Join with Hide my IP on?": the group's call server, which its admin chose, sees this device's IP; asked once. */
function HideIpDialog({ onClose, onConfirm }: { onClose(): void; onConfirm(): void }) {
  const { t } = useI18n();
  const id = useId();
  const [info, setInfo] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null), cancel = useRef<HTMLButtonElement>(null);
  const backdrop = useBackdropDismiss(onClose);
  useBackCloses(onClose);
  useQuestionDialog(dialog, cancel);
  return createPortal(<dialog ref={dialog} {...backdrop} onCancel={e => { e.preventDefault(); e.stopPropagation(); onClose(); }} aria-labelledby={`${id}-title`} aria-describedby={`${id}-body`}
    data-testid="group-call-hide-ip" className="m-auto w-[calc(100%_-_2rem)] max-w-sm rounded-2xl border border-border bg-sidebar-bg p-5 text-text-primary shadow-2xl backdrop:bg-black/60">
    <h2 id={`${id}-title`} className="text-base font-semibold">{t("calls.group.hideIpTitle")}</h2>
    <div className="mt-2 flex items-start gap-1.5">
      <p id={`${id}-body`} className="m-0 min-w-0 flex-1 text-sm text-text-muted">{t("calls.group.hideIpBody")}</p>
      <InfoButton open={info} onToggle={() => setInfo(!info)} controls={`${id}-info`} testId="group-call-hide-ip-info" className="mt-0.5" />
    </div>
    {info && <p id={`${id}-info`} data-testid="group-call-hide-ip-info-text" className="mt-2 border-s-2 border-border ps-2 text-xs text-text-secondary">{t("calls.group.hideIpInfo")}</p>}
    <div className="mt-5 flex justify-end gap-2">
      <button ref={cancel} onClick={onClose} data-testid="group-call-hide-ip-cancel" className="min-h-11 rounded-lg px-4 text-sm hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-accent">{t("common.cancel")}</button>
      <button onClick={onConfirm} data-testid="group-call-hide-ip-confirm"
        className="min-h-11 rounded-lg px-4 text-sm font-semibold text-accent hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-accent">{t("calls.group.joinAnyway")}</button>
    </div>
  </dialog>, document.body);
}

/** "End your call?": joining the group's call ends the 1:1 call on now, as answering another call does. */
function EndOtherCallDialog({ onClose, onConfirm }: { onClose(): void; onConfirm(): void }) {
  const { t } = useI18n();
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null), cancel = useRef<HTMLButtonElement>(null);
  const backdrop = useBackdropDismiss(onClose);
  useBackCloses(onClose);
  useQuestionDialog(dialog, cancel);
  return createPortal(<dialog ref={dialog} {...backdrop} onCancel={e => { e.preventDefault(); e.stopPropagation(); onClose(); }} aria-labelledby={`${id}-title`} aria-describedby={`${id}-body`}
    data-testid="group-call-end-other" className="m-auto w-[calc(100%_-_2rem)] max-w-sm rounded-2xl border border-border bg-sidebar-bg p-5 text-text-primary shadow-2xl backdrop:bg-black/60">
    <h2 id={`${id}-title`} className="text-base font-semibold">{t("calls.group.endOtherTitle")}</h2>
    <p id={`${id}-body`} className="mt-2 text-sm text-text-muted">{t("calls.group.endOtherBody")}</p>
    <div className="mt-5 flex justify-end gap-2">
      <button ref={cancel} onClick={onClose} className="min-h-11 rounded-lg px-4 text-sm hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-accent">{t("common.cancel")}</button>
      <button onClick={onConfirm} data-testid="group-call-end-other-confirm"
        className="min-h-11 rounded-lg px-4 text-sm bg-danger/15 text-danger-ink hover:bg-danger/25 forced-colors:border forced-colors:border-[color:ButtonText] focus-visible:ring-2 focus-visible:ring-danger">{t("calls.group.endAndJoin")}</button>
    </div>
  </dialog>, document.body);
}
