import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CORNERS, useFloatingBox } from "../hooks/useFloatingBox";
import type { CallDevices } from "../hooks/useCallDevices";
import { applySpeaker } from "../lib/mediaDevices";
import { useI18n } from "../contexts/I18nContext";
import { useBackCloses, useTabTrap } from "../hooks/useDismiss";
import { initial } from "../lib/initial";
import { fillNames } from "../lib/fillNodes";
import { callWindowShown } from "../lib/serviceWindows";
import { DeviceMenu } from "./CallOverlay";

/** One person in a group call, as `useGroupCall` gives them: what they send, and the tracks to show and play. */
export interface GroupCallParticipant {
  identity: string;
  name: string;
  mic: boolean;
  camera: boolean;
  screen: boolean;
  speaking: boolean;
  /** Played and shown here: the hook attaches none of them to the page itself. */
  tracks: { audio?: MediaStreamTrack | null; camera?: MediaStreamTrack | null; screen?: MediaStreamTrack | null };
}

/** The `useGroupCall` state the view draws. `local` is you; `participants` are everyone else. */
export interface GroupCallState {
  participants: GroupCallParticipant[];
  activeSpeaker: string | null;
  local: GroupCallParticipant;
}

interface GroupCallViewProps {
  call: GroupCallState;
  /** The group's name, the window's name to a screen reader. */
  groupName: string;
  onToggleMic: () => void;
  onToggleCamera: () => void;
  onToggleScreen: () => void;
  onLeave: () => void;
  /** The browser can capture a screen (none on phones): the share button shows. */
  canShareScreen?: boolean;
  /** The group is off screen: the call rides along in its small window until you go back to it. */
  pinned?: boolean;
  onReturnToChat?: () => void;
  layer?: HTMLElement | null;
  devices?: CallDevices | null;
  /** Someone's name by their key, as the group knows them: the node's own name for them is not believed. */
  nameOf?: (identity: string) => string;
}

const MINI_KEY = "ghostly_group_call_mini";

/** Columns for `n` tiles: as square as it goes, so 4 is 2 × 2, 9 is 3 × 3 and 25 is 5 × 5. */
function gridColumns(n: number): number {
  return Math.max(1, Math.ceil(Math.sqrt(n)));
}

/**
 * Who shares a screen, the first to start first. Kept across renders: when two share, the latest takes the main area
 * and the other is a tile; when the latest stops, the one before is back in the main area.
 */
function useShareOrder(sharing: string[]): string[] {
  const order = useRef<string[]>([]);
  const kept = order.current.filter((id) => sharing.includes(id));
  const next = [...kept, ...sharing.filter((id) => !kept.includes(id))];
  order.current = next;
  return next;
}

/** A track drawn in a <video>, muted: the sound plays from the participant's own <audio>. */
function TrackVideo({ track, fit, mirror }: { track: MediaStreamTrack; fit: "cover" | "contain"; mirror?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (!ref.current || typeof MediaStream !== "function") return;
    try {
      ref.current.srcObject = new MediaStream([track]);
    } catch {
      // a track this browser cannot draw: the tile keeps its black
    }
  }, [track]);
  return <video ref={ref} autoPlay playsInline muted className={`absolute inset-0 w-full h-full bg-black ${fit === "contain" ? "object-contain" : "object-cover"}`} style={mirror ? { transform: "scaleX(-1)" } : undefined} />;
}

/** Someone's sound, on the chosen speaker. */
function TrackAudio({ track, speaker }: { track: MediaStreamTrack; speaker?: string }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    if (!ref.current || typeof MediaStream !== "function") return;
    try {
      ref.current.srcObject = new MediaStream([track]);
    } catch {
      // nothing to play here
    }
  }, [track]);
  useEffect(() => {
    void applySpeaker(ref.current, speaker).catch(() => {});
  }, [speaker, track]);
  return <audio ref={ref} autoPlay className="hidden" data-testid="group-call-audio" />;
}

function MutedMark({ label }: { label: string }) {
  return (
    <span data-testid="group-call-muted" role="img" aria-label={label} title={label} className="grid place-items-center w-6 h-6 rounded-full bg-black/60 text-danger shrink-0">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <line x1="1" y1="1" x2="23" y2="23" />
        <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6M17 16.95A7 7 0 0 1 5 12v-2m14 0v2c0 .76-.13 1.49-.35 2.17M12 19v4" />
      </svg>
    </span>
  );
}

/** A face (camera or avatar) or a shared screen, with the name and a muted mark; the active speaker wears a ring. */
function Tile({ person, you, kind, speaking, name, face }: { person: GroupCallParticipant; you: boolean; kind: "face" | "screen"; speaking: boolean; name: ReactNode; face: string }) {
  const { t } = useI18n();
  const track = kind === "screen" ? person.tracks.screen : person.camera ? person.tracks.camera : null;
  return (
    <div
      data-testid="group-call-tile"
      data-identity={person.identity}
      data-kind={kind}
      data-speaking={speaking}
      data-video={!!track}
      className={`group-call-tile relative min-w-0 min-h-0 overflow-hidden rounded-xl bg-surface-hover flex items-center justify-center ${speaking ? "ring-[3px] ring-accent" : ""}`}
    >
      {track ? (
        <TrackVideo track={track} fit={kind === "screen" ? "contain" : "cover"} mirror={you && kind === "face"} />
      ) : (
        <div className="call-avatar shrink-0 w-[min(40%,6rem)] aspect-square rounded-full bg-chat-bg flex items-center justify-center">
          {/* A letter for the eye: the name below is what a screen reader reads ("M You" read the letter of your name). */}
          <span aria-hidden="true" className="text-text-muted text-2xl">{initial(face)}</span>
        </div>
      )}
      <div className="absolute bottom-1.5 inset-x-1.5 flex items-center gap-1.5">
        {kind === "face" && !person.mic && <MutedMark label={t("calls.group.muted")} />}
        <span dir="auto" className="min-w-0 truncate rounded-md bg-black/60 px-1.5 py-0.5 text-xs text-white">{name}</span>
      </div>
    </div>
  );
}

/**
 * A group call through the group's node: everyone's tile in a grid, the active speaker ringed, and a shared screen
 * large with the faces beside it. Drawn from `useGroupCall`'s state, passed in; it imports no LiveKit.
 */
export function GroupCallView({ call, groupName, onToggleMic, onToggleCamera, onToggleScreen, onLeave, canShareScreen = false, pinned = false, onReturnToChat, layer, devices = null, nameOf: groupNameOf }: GroupCallViewProps) {
  const { t } = useI18n();
  const infoId = useId();
  const [info, setInfo] = useState(false);
  const [miniPreference, setMiniState] = useState(() => localStorage.getItem(MINI_KEY) === "1");
  const mini = pinned || miniPreference;
  const setMini = (next: boolean) => {
    setMiniState(next);
    try {
      localStorage.setItem(MINI_KEY, next ? "1" : "0");
    } catch {
      // only a preference
    }
  };
  // The sizes of the 1:1 call's small window (CallOverlay): on a touch screen its five buttons need 264 × 168.
  const phone = window.innerWidth < 768;
  const touch = typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
  const miniWindow = useFloatingBox(
    "ghostly_group_call_window_box",
    () => (phone
      ? touch ? { x: window.innerWidth - 280, y: window.innerHeight - 272, w: 264, h: 168 } : { x: window.innerWidth - 206, y: window.innerHeight - 240, w: 190, h: 136 }
      : { x: window.innerWidth - 364, y: window.innerHeight - 316, w: 340, h: 220 }),
    { enabled: mini, minWidth: touch ? 264 : 190, minHeight: touch ? 168 : 128 },
  );
  const box = miniWindow.boxProps.ref;
  useEffect(callWindowShown, []);
  useTabTrap(box, !mini);
  useBackCloses(() => setMiniState(true), !mini);
  // Whole-screen, the focus comes into the call. Either way, what had it (Join call) has it back when the call goes
  // with the focus in it, as in the 1:1 call (CallOverlay): a Leave pressed by keyboard left it on the page's body.
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const active = document.activeElement as HTMLElement | null;
    if (box.current && !box.current.contains(active)) {
      if (active && active !== document.body) opener.current = active;
      if (!mini) box.current.focus({ preventScroll: true });
    }
    return () => {
      const before = opener.current;
      if (before?.isConnected && (!document.activeElement || document.activeElement === document.body)) before.focus({ preventScroll: true });
    };
  }, [mini, box]);

  const { local, participants, activeSpeaker } = call;
  const everyone = [local, ...participants];
  // Everyone else by the group's own name for their key (WISP 602 § The reply): the node's name is not theirs to vouch for.
  const shown = (p: GroupCallParticipant) => (p === local || !groupNameOf ? p.name : groupNameOf(p.identity));
  const nameOf = (p: GroupCallParticipant) => (p === local ? t("calls.you") : shown(p));
  const order = useShareOrder(everyone.filter((p) => p.screen && p.tracks.screen).map((p) => p.identity));
  const presenter = everyone.find((p) => p.identity === order[order.length - 1]) ?? null;
  // The other screens are tiles beside the faces.
  const otherScreens = order.slice(0, -1).map((id) => everyone.find((p) => p.identity === id)!);
  const faces = everyone.map((p) => (
    <Tile key={p.identity} person={p} you={p === local} kind="face" speaking={p.identity === activeSpeaker} name={nameOf(p)} face={shown(p)} />
  ));
  const screenTiles = otherScreens.map((p) => (
    <Tile key={`${p.identity}-screen`} person={p} you={p === local} kind="screen" speaking={false} name={fillNames(t("calls.group.screenOf"), { name: nameOf(p) })} face={shown(p)} />
  ));
  // The small window shows one tile: the screen being shared, or else whoever speaks.
  const focus = presenter ?? everyone.find((p) => p.identity === activeSpeaker) ?? participants[0] ?? local;
  const columns = gridColumns(faces.length + screenTiles.length);

  const roundButton = "w-14 h-14 max-md:w-16 max-md:h-16 rounded-full flex items-center justify-center transition-colors cursor-pointer";
  return createPortal(
    <div
      {...miniWindow.boxProps}
      data-testid="group-call"
      data-mini={mini}
      data-count={everyone.length}
      {...(mini ? {} : { role: "dialog", "aria-modal": true, "aria-label": groupName, tabIndex: -1 })}
      className={
        mini
          ? "call-mini floating fixed z-50 bg-chat-bg flex flex-col items-center justify-center rounded-xl border border-border shadow-2xl overflow-hidden"
          : "fixed inset-0 max-md:top-6 max-md:rounded-t-2xl max-md:border-t max-md:border-border z-50 bg-chat-bg/95 max-md:bg-chat-bg flex flex-col focus:outline-none"
      }
    >
      {mini && CORNERS.map((corner) => <div key={corner} className={`float-grip float-grip-${corner}`} {...miniWindow.handleProps(corner)} />)}
      <button
        onClick={() => (pinned ? onReturnToChat?.() : setMini(!mini))}
        className="call-resize absolute top-4 left-4 z-20 w-11 h-11 rounded-full bg-white/10 text-white hover:bg-white/20 flex items-center justify-center cursor-pointer transition-colors"
        title={pinned ? t("calls.window.chat") : mini ? t("calls.window.full") : t("calls.window.small")}
        data-testid="group-call-minimize"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          {mini ? <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" /> : <path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" />}
        </svg>
      </button>

      {participants.map((p) => p.tracks.audio && <TrackAudio key={p.identity} track={p.tracks.audio} speaker={devices?.speaker} />)}

      {mini ? (
        <div className="absolute inset-0 grid">
          {focus === presenter ? (
            <Tile person={focus} you={focus === local} kind="screen" speaking={false} name={fillNames(t("calls.group.screenOf"), { name: nameOf(focus) })} face={shown(focus)} />
          ) : (
            <Tile person={focus} you={focus === local} kind="face" speaking={focus.identity === activeSpeaker} name={nameOf(focus)} face={shown(focus)} />
          )}
        </div>
      ) : (
        <>
          <div className="call-top flex items-center justify-center gap-1.5 px-16 pt-6 pb-2">
            <p dir="auto" className="min-w-0 truncate text-text-primary font-medium">{groupName}</p>
            <button type="button" data-testid="group-call-info" aria-expanded={info} aria-controls={infoId} aria-label={t("common.moreInfo")} title={t("common.moreInfo")}
              onClick={() => setInfo(!info)}
              className="grid h-5 w-5 shrink-0 cursor-pointer place-items-center rounded-full text-text-muted transition-colors hover:text-accent aria-expanded:text-accent">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9.5" /><path d="M12 11v5.5M12 7.5v.01" /></svg>
            </button>
          </div>
          {info && <p id={infoId} data-testid="group-call-info-text" className="mx-auto max-w-md px-4 pb-2 text-center text-xs text-text-secondary break-words">{t("calls.group.info")}</p>}
          {presenter ? (
            <div data-testid="group-call-stage" className="call-tiles flex-1 min-h-0 flex max-md:flex-col gap-2">
              <div className="flex-1 min-w-0 min-h-0 grid">
                <Tile person={presenter} you={presenter === local} kind="screen" speaking={false} name={fillNames(t("calls.group.screenOf"), { name: nameOf(presenter) })} face={shown(presenter)} />
              </div>
              <div data-testid="group-call-side" className="md:w-48 max-md:h-28 shrink-0 flex md:flex-col gap-2 overflow-auto">
                {[...screenTiles, ...faces].map((tile) => <div key={tile.key} className="shrink-0 grid md:h-28 max-md:w-36">{tile}</div>)}
              </div>
            </div>
          ) : (
            <div data-testid="group-call-grid" className="call-tiles flex-1 min-h-0 grid gap-2 auto-rows-fr" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
              {faces}
            </div>
          )}
        </>
      )}

      <div className="call-controls absolute bottom-12 max-md:bottom-[calc(2rem+env(safe-area-inset-bottom))] left-0 right-0 flex items-center justify-center gap-6 max-md:gap-8 z-10">
        <button onClick={onToggleMic} data-testid="group-call-mic" title={local.mic ? t("calls.mute") : t("calls.unmute")}
          className={`${roundButton} ${local.mic ? "bg-white/10 text-white hover:bg-white/20" : "bg-danger/30 text-danger"}`}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            {local.mic
              ? <><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8" /></>
              : <><line x1="1" y1="1" x2="23" y2="23" /><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6M17 16.95A7 7 0 0 1 5 12v-2m14 0v2c0 .76-.13 1.49-.35 2.17M12 19v4M8 23h8" /></>}
          </svg>
        </button>
        <button onClick={onToggleCamera} data-testid="group-call-camera" title={local.camera ? t("calls.turnCameraOff") : t("calls.turnCameraOn")}
          className={`${roundButton} ${local.camera ? "bg-white/10 text-white hover:bg-white/20" : "bg-danger/30 text-danger"}`}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            {local.camera
              ? <><path d="M23 7l-7 5 7 5V7z" /><rect x="1" y="5" width="15" height="14" rx="2" ry="2" /></>
              : <><line x1="1" y1="1" x2="23" y2="23" /><path d="M21 21H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3m3-3h6l2 3h4a2 2 0 0 1 2 2v9.34m-7.72-2.06a4 4 0 1 1-5.56-5.56" /></>}
          </svg>
        </button>
        {devices && <DeviceMenu devices={devices} overVideo={false} host={mini ? null : box} />}
        {canShareScreen && (
          <button onClick={onToggleScreen} data-testid="group-call-screen" aria-label={local.screen ? t("calls.stopSharing") : t("calls.shareScreen")} title={local.screen ? t("calls.stopSharing") : t("calls.shareScreen")}
            className={`${roundButton} ${local.screen ? "bg-accent text-on-accent forced-colors:forced-color-adjust-none forced-colors:bg-[color:Highlight] forced-colors:text-[color:HighlightText]" : "bg-white/10 text-white hover:bg-white/20"}`}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="2" y="4" width="20" height="13" rx="2" />
              <path d="M8 21h8M12 17v4M12 13V8m0 0l-2.5 2.5M12 8l2.5 2.5" />
            </svg>
          </button>
        )}
        <button onClick={onLeave} data-testid="group-call-leave" title={t("calls.group.leave")}
          className="w-16 h-16 max-md:w-[72px] max-md:h-[72px] rounded-full bg-danger-fill flex items-center justify-center text-white hover:bg-danger-fill/80 transition-colors cursor-pointer">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91" />
            <line x1="23" y1="1" x2="1" y2="23" />
          </svg>
        </button>
      </div>
    </div>,
    layer ?? document.body,
  );
}
