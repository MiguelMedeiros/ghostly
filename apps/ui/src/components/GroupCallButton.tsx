import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { endOtherCalls, otherCallOn, setCallOn } from "@ghostly/react";
import type { GroupView } from "@ghostly/browser/shared/types";
import { useI18n } from "../contexts/I18nContext";
import { useBackCloses, useBackdropDismiss, useQuestionDialog } from "../hooks/useDismiss";
import { useGroupCall, type LivekitModule } from "../hooks/useGroupCall";
import { useHandler } from "../hooks/useHandler";
import { askGroupCallPass, groupCallProblem, PASS_REFRESH_LEAD_S, passRefreshInMs, type GroupCallPass } from "../lib/groupCallPass";
import { focus } from "../lib/connection";
import { working } from "../lib/focus";
import type { Problem } from "../lib/problemText";
import { GroupCallView } from "./GroupCallView";
import { Notice } from "./ui/Notice";

/** A refresh the node did not answer is asked again this much later, while the pass still holds. */
const REFRESH_RETRY_MS = 30_000;

/**
 * Join call in the header of a group with a call node (WISP 602): asks the node for a pass, joins its room
 * (`useGroupCall`) and opens the call's window. One call at a time: on a 1:1 call, it asks to end that one first; a
 * 1:1 call answered while this one is on ends it (`callRegistry`).
 */
export function GroupCallButton({ group, loadLivekit }: { group: GroupView; loadLivekit?: () => Promise<LivekitModule> }) {
  const { t } = useI18n();
  const groupId = group.id;
  const id = useId();
  const [key] = useState(() => Symbol("group call"));
  /** The pass the room was joined with: it stays while in the room, since a new token would leave and join again. */
  const [joined, setJoined] = useState<GroupCallPass | null>(null);
  /** The newest pass, asked again before it runs out, for joining again after a drop without asking the node. */
  const held = useRef<{ pass: GroupCallPass; until: number } | null>(null);
  const [asking, setAsking] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [askEnd, setAskEnd] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const call = useGroupCall({ url: joined?.url ?? "", token: joined?.token ?? "", iceServers: joined?.iceServers, loadLivekit });

  const hold = (pass: GroupCallPass) => { held.current = { pass, until: Date.now() + pass.expiresIn * 1000 }; };
  const join = useHandler(async () => {
    setProblem(null);
    const kept = held.current;
    if (kept && kept.until - Date.now() > PASS_REFRESH_LEAD_S * 1000) return setJoined(kept.pass);
    setAsking(true);
    try {
      const pass = await askGroupCallPass(groupId);
      hold(pass);
      setJoined(pass);
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
  const press = () => {
    if (asking) return;
    if (otherCallOn(key)) setAskEnd(true);
    else void join();
  };

  useEffect(() => {
    if (!joined) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const ask = async () => {
      try {
        const pass = await askGroupCallPass(groupId);
        if (!live) return;
        hold(pass);
        timer = setTimeout(ask, passRefreshInMs(pass.expiresIn));
      } catch {
        if (live) timer = setTimeout(ask, REFRESH_RETRY_MS);
      }
    };
    timer = setTimeout(ask, passRefreshInMs(joined.expiresIn));
    return () => { live = false; clearTimeout(timer); };
  }, [joined, groupId]);

  // On the app's calls while in the room: a 1:1 call answered meanwhile ("End and answer") leaves it.
  const on = !!joined && (call.status === "connecting" || call.status === "connected");
  useEffect(() => {
    if (!on) return;
    setCallOn(key, leave);
    return () => setCallOn(key, null);
  }, [on, key, leave]);

  // The room closed (the node dropped you) or would not take you: the window goes, and a failed join says why.
  useEffect(() => {
    if (call.status === "failed") setProblem(groupCallProblem(call.error?.cause ?? call.error?.message, t));
    if (call.status === "failed" || call.status === "left") setJoined(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only the status moving there ends it
  }, [call.status]);

  const canShareScreen = typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getDisplayMedia === "function";
  return (
    <div className="relative shrink-0">
      <button ref={button} type="button" onClick={press} {...working(asking)} data-testid="group-call-join"
        title={t("calls.group.join")} aria-label={t("calls.group.join")} aria-describedby={problem ? `${id}-problem` : undefined}
        className={`flex cursor-pointer items-center justify-center rounded-full p-2 text-text-secondary transition-colors hover:bg-surface-hover hover:text-accent aria-disabled:opacity-40 max-md:h-[44px] max-md:w-[44px] max-md:p-0 ${focus}`}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M23 7l-7 5 7 5V7z" /><rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
        </svg>
      </button>
      {problem && <div id={`${id}-problem`} data-testid="group-call-problem" className="absolute end-0 top-full z-40 mt-2 w-[min(18rem,calc(100vw-1rem))] rounded-xl border border-border bg-panel-header p-3 shadow-xl">
        <Notice problem={problem} testId="group-call-problem-notice" />
        <div className="mt-2 flex justify-end gap-2 text-xs">
          <button type="button" onClick={() => { setProblem(null); button.current?.focus(); }} className={`min-h-8 rounded-md px-2 text-text-secondary hover:bg-surface-hover max-md:min-h-11 ${focus}`}>{t("common.close")}</button>
          <button type="button" onClick={() => void join()} data-testid="group-call-retry" className={`min-h-8 rounded-md px-2 font-semibold text-accent hover:bg-surface-hover max-md:min-h-11 ${focus}`}>{t("calls.group.retry")}</button>
        </div>
      </div>}
      {joined && <GroupCallView call={call} groupName={group.name || t("group.chat.unnamed")} canShareScreen={canShareScreen}
        onToggleMic={() => void call.toggleMic()} onToggleCamera={() => void call.toggleCamera()} onToggleScreen={() => void call.toggleScreen()} onLeave={leave} />}
      {askEnd && <EndOtherCallDialog onClose={() => setAskEnd(false)} onConfirm={() => { setAskEnd(false); endOtherCalls(key); void join(); }} />}
    </div>
  );
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
