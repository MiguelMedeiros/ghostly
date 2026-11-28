import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { mediaProblem, SCREEN_SHARE_ERROR_MS } from "@ghostly/react";
import { CORNERS, useFloatingBox } from "../hooks/useFloatingBox";
import type { CallDevices } from "../hooks/useCallDevices";
import type { GroupCallError } from "../hooks/useGroupCall";
import { applySpeaker } from "../lib/mediaDevices";
import { useI18n, type Translate, type TranslationKey } from "../contexts/I18nContext";
import { listText } from "../lib/listText";
import { useBackCloses, useTabTrap } from "../hooks/useDismiss";
import { useFocusKept } from "../hooks/useFocusKept";
import { initial } from "../lib/initial";
import { fillNames } from "../lib/fillNodes";
import { errorText } from "../lib/errorText";
import { callWindowShown } from "../lib/serviceWindows";
import { mediaProblemKeys } from "../lib/mediaProblemText";
import { ownDirection } from "../lib/ownDirection";
import { isolate } from "../lib/ownStatus";
import { openAppSettings } from "../desktop/androidCameraRefusal";
import { DeviceMenu, DeviceNoticeBar } from "./CallOverlay";
import { InfoButton } from "./layout/Section";
import { useCallModeration, type GroupCallModerator } from "../hooks/useCallModeration";
import { ModerationProblem, RemovedFromCall, TileModerationMenu } from "./GroupCallModerationMenu";
import { TileVolume } from "./GroupCallVolume";
import { elementTakesVolume, gainPlays, setVolumeOf, volumeMaxOn, volumeOf } from "../lib/groupCallVolume";

/** One person in a group call, as `useGroupCall` gives them: what they send, and the tracks to show and play. */
export interface GroupCallParticipant {
  identity: string;
  name: string;
  mic: boolean;
  camera: boolean;
  screen: boolean;
  /** Their shared screen carries its sound (a tab's or the system's); false while sharing a screen without it. */
  screenSound?: boolean;
  speaking: boolean;
  /** What the group's admin took away from them in this call (WISP 602 § Moderation): off until the admin allows it. */
  byAdmin?: { mic: boolean; camera: boolean; screen: boolean };
  /** Played and shown here: the hook attaches none of them to the page itself. */
  tracks: { audio?: MediaStreamTrack | null; camera?: MediaStreamTrack | null; screen?: MediaStreamTrack | null; screenAudio?: MediaStreamTrack | null };
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
  /** In the room (`useGroupCall`'s status "connected"): said once, and who comes and goes after it is said too. */
  connected?: boolean;
  /** `useGroupCall`'s last error: a refused mic, camera or screen share is said for a few seconds, or until the next try. */
  error?: GroupCallError | null;
  /** Someone's name by their key, as the group knows them: the node's own name for them is not believed. */
  nameOf?: (identity: string) => string;
  /** Moves each time Join call is pressed while in the call: the small window opens whole again. */
  raised?: number;
  /** You are the group's admin: each other member's tile has a menu to mute or remove them (WISP 602 § Moderation). */
  moderator?: GroupCallModerator;
}

const MINI_KEY = "ghostly_group_call_mini";

/**
 * Why your mic, camera or screen did not come on, as the 1:1 call says it: a title, and the next step when there is one.
 * Refused in the Android app, `android`: the line opens Android's settings, as the 1:1 call's notice does.
 */
function errorLines(error: GroupCallError, t: Translate): { title: string; next?: string; android?: boolean } {
  if (error.action === "mic" || error.action === "camera") {
    const problem = mediaProblem(error.cause);
    if (problem === "denied" || problem === "unavailable") {
      const { title, next, android } = mediaProblemKeys(problem, error.action);
      return { title: t(title), next: t(next), android };
    }
  }
  // The screen share's line (`screenShareErrorMessage`), or an error the table knows; else as it came.
  return { title: errorText(error.message, t) };
}

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

/**
 * What a screen reader hears as the call moves on: "Connected" once in the room, then who joined and who left, several
 * at once in one line ("Ana, Bo joined"), and those who left on a line of their own. The people already there when you join are not read out one by one, and the active speaker and
 * others' mics are left out: they change every few seconds.
 */
function useCallNews(participants: GroupCallParticipant[], connected: boolean, t: Translate): string[] {
  const [news, setNews] = useState<string[]>([]);
  const seen = useRef<Map<string, string> | null>(null);
  const people = participants.map((p) => `${p.identity}\n${p.name}`).join("\n\n");
  useEffect(() => {
    if (!connected) {
      seen.current = null;
      setNews([]);
      return;
    }
    const before = seen.current;
    const now = new Map(participants.map((p) => [p.identity, p.name]));
    seen.current = now;
    if (!before) {
      setNews([t("calls.connected")]);
      return;
    }
    const joined = [...now].filter(([id]) => !before.has(id)).map(([, name]) => name);
    const left = [...before].filter(([id]) => !now.has(id)).map(([, name]) => name);
    const said = (names: string[], one: TranslationKey, many: TranslationKey) =>
      names.length === 0 ? [] : [names.length === 1 ? t(one, { name: names[0]! }) : t(many, { names: listText(names, t) })];
    const lines = [...said(joined, "calls.group.joined", "calls.group.joinedMany"), ...said(left, "calls.group.left", "calls.group.leftMany")];
    if (lines.length) setNews(lines);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `people` stands for the participants
  }, [connected, people, t]);
  return news;
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

/**
 * Someone's sound (their voice, or their shared screen's), on the chosen speaker, as loud as you set them (`volume`,
 * 1 as sent). Up to 1 the element's own volume, and 0 mutes it. Past 1, which an element can't play, or any level on
 * an engine that ignores the element's volume (iOS), through a Web Audio gain with the element muted while the gain
 * plays: it keeps the stream, which Chrome plays to Web Audio only while an element holds it. A context that doesn't
 * run (WebKit starts none outside a gesture, iOS interrupts one) leaves the element playing, as close to the level as
 * it can (at most 1), and each move of the slider, a gesture, asks it to start again. An engine whose Web
 * Audio can't play on the speaker you chose stays at 1 there, and its slider stops there too (`volumeMaxOn`).
 */
function TrackAudio({ track, speaker, volume = 1, testId = "group-call-audio" }: { track: MediaStreamTrack; speaker?: string; volume?: number; testId?: string }) {
  const ref = useRef<HTMLAudioElement>(null);
  const boost = useRef<{ context: AudioContext; gain: GainNode; live: () => void } | null>(null);
  const [takesVolume] = useState(elementTakesVolume);
  const played = Math.min(volume, volumeMaxOn(speaker));
  const level = useRef(played);
  level.current = played;
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
  const throughGain = played !== 1 && (played > 1 || !takesVolume) && gainPlays(speaker);
  useEffect(() => {
    const element = ref.current;
    if (!throughGain || !element) return;
    let context: AudioContext;
    let gain: GainNode;
    try {
      context = new AudioContext();
      gain = context.createGain();
      gain.gain.value = level.current;
      context.createMediaStreamSource(new MediaStream([track])).connect(gain).connect(context.destination);
    } catch {
      // no Web Audio for this track: it plays at 1
      return;
    }
    // The element is muted only while the gain plays, and only for this gain (a closed one's late resume says nothing).
    const live = () => {
      if (boost.current?.context !== context) return;
      const plays = context.state === "running";
      element.muted = plays || level.current === 0;
      // Not yet: the element plays them, as close to the level as it can.
      if (!plays) element.volume = Math.min(1, level.current);
    };
    boost.current = { context, gain, live };
    context.onstatechange = live;
    live();
    void context.resume().catch(() => {}).then(live);
    void applySpeaker(context, speaker).catch(() => {});
    return () => {
      boost.current = null;
      context.onstatechange = null;
      void context.close().catch(() => {});
      element.muted = level.current === 0;
    };
  }, [throughGain, track, speaker]);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (boost.current) {
      const { context, gain, live } = boost.current;
      gain.gain.value = played;
      live();
      // A context made outside a gesture (a kept level, as a call starts) can start in this one: the slider's.
      if (context.state !== "running") void context.resume().catch(() => {}).then(live);
      return;
    }
    element.volume = Math.min(1, played);
    element.muted = played === 0;
  }, [played, throughGain, track]);
  return <audio ref={ref} autoPlay className="hidden" data-testid={testId} />;
}

/** Muted, or muted by the admin (`byAdmin`): ringed, and named so, on the tile and to a screen reader. */
function MutedMark({ label, byAdmin = false }: { label: string; byAdmin?: boolean }) {
  return (
    <span data-testid="group-call-muted" data-by-admin={byAdmin} role="img" aria-label={label} title={label}
      className={`grid place-items-center w-6 h-6 rounded-full bg-black/60 text-danger shrink-0 ${byAdmin ? "ring-2 ring-danger forced-colors:border forced-colors:border-[color:CanvasText]" : ""}`}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <line x1="1" y1="1" x2="23" y2="23" />
        <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6M17 16.95A7 7 0 0 1 5 12v-2m14 0v2c0 .76-.13 1.49-.35 2.17M12 19v4" />
      </svg>
    </span>
  );
}

/**
 * A face (camera or avatar) or a shared screen, with the name and a muted mark; the active speaker wears a ring. `whole`:
 * the screen the whole window shows, edge to edge on black, without a tile's rounded corners.
 */
function Tile({ person, you, kind, speaking, name, face, menu, whole = false }: { person: GroupCallParticipant; you: boolean; kind: "face" | "screen"; speaking: boolean; name: ReactNode; face: string; menu?: ReactNode; whole?: boolean }) {
  const { t } = useI18n();
  const track = kind === "screen" ? person.tracks.screen : person.camera ? person.tracks.camera : null;
  return (
    <div
      data-testid="group-call-tile"
      data-identity={person.identity}
      data-kind={kind}
      data-speaking={speaking}
      data-video={!!track}
      className={`group-call-tile relative min-w-0 min-h-0 overflow-hidden ${whole ? "bg-black" : "rounded-xl bg-surface-hover"} flex items-center justify-center ${speaking ? "ring-[3px] ring-accent" : ""}`}
    >
      {track ? (
        <TrackVideo track={track} fit={kind === "screen" ? "contain" : "cover"} mirror={you && kind === "face"} />
      ) : (
        <div className="call-avatar shrink-0 w-[min(40%,6rem)] aspect-square rounded-full bg-chat-bg flex items-center justify-center">
          {/* A letter for the eye: the name below is what a screen reader reads ("M You" read the letter of your name). */}
          <span aria-hidden="true" className="text-text-muted text-2xl">{initial(face)}</span>
        </div>
      )}
      <div className={`absolute flex items-center gap-1.5 ${whole ? "bottom-[calc(0.375rem+env(safe-area-inset-bottom))] left-[calc(0.375rem+env(safe-area-inset-left))] right-[calc(0.375rem+env(safe-area-inset-right))]" : "bottom-1.5 inset-x-1.5"}`}>
        {kind === "face" && (person.byAdmin?.mic ? <MutedMark label={t("calls.group.mutedByAdmin")} byAdmin /> : !person.mic && <MutedMark label={t("calls.group.muted")} />)}
        <span dir="auto" className="min-w-0 truncate rounded-md bg-black/60 px-1.5 py-0.5 text-xs text-white">{name}</span>
        {/* What the others get of your screen's sound: all the system plays (but this page), or nothing when the
            browser gave the picture alone (or the sound was left unticked). */}
        {kind === "screen" && you && person.screenSound !== undefined && (
          <span data-testid="group-call-screen-sound" data-sound={person.screenSound} className="min-w-0 truncate rounded-md bg-black/60 px-1.5 py-0.5 text-xs text-white">
            {t(person.screenSound ? "calls.sharing.withSound" : "calls.sharing.noSound")}
          </span>
        )}
      </div>
      {menu}
    </div>
  );
}

/**
 * A group call through the group's node: everyone's tile in a grid, the active speaker ringed, and a shared screen
 * large with the faces beside it. Drawn from `useGroupCall`'s state, passed in; it imports no LiveKit.
 */
export function GroupCallView({ call, groupName, onToggleMic, onToggleCamera, onToggleScreen, onLeave, canShareScreen = false, pinned = false, onReturnToChat, layer, devices = null, connected = true, error = null, nameOf: groupNameOf, raised = 0, moderator }: GroupCallViewProps) {
  const { t } = useI18n();
  const moderation = useCallModeration(moderator, connected);
  // How loud each of the others plays here, kept by their key past this call (lib/groupCallVolume.ts).
  const [, setVolumesSet] = useState(0);
  const setVolume = (identity: string, volume: number) => {
    setVolumeOf(identity, volume);
    setVolumesSet((n) => n + 1);
  };
  // Each new error is said anew (its own alert), and goes after a few seconds; a failed join has no window to say it in.
  const [said, setSaid] = useState({ error, id: 0, over: false });
  if (said.error !== error) setSaid({ error, id: said.id + 1, over: false });
  const shownError = said.error === error && !said.over && error?.action !== "join" ? error : null;
  useEffect(() => {
    if (!shownError) return;
    const timer = setTimeout(() => setSaid((s) => (s.error === shownError ? { ...s, over: true } : s)), SCREEN_SHARE_ERROR_MS);
    return () => clearTimeout(timer);
  }, [shownError]);
  const errorShown = shownError && errorLines(shownError, t);
  const infoId = useId();
  const [info, setInfo] = useState(false);
  const heldInfoId = useId();
  const [heldInfo, setHeldInfo] = useState(false);
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
  // Join call pressed again while in the call: the small window opens whole, as its own button does.
  useEffect(() => {
    if (raised) setMini(false);
  }, [raised]);
  // The sizes of the 1:1 call's small window (CallOverlay): on a touch screen its five buttons need 264 × 168.
  const phone = window.innerWidth < 768;
  const touch = typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
  const miniWindow = useFloatingBox(
    "ghostly_group_call_window_box",
    () => (phone
      ? touch ? { x: window.innerWidth - 280, y: window.innerHeight - 272, w: 264, h: 168 } : { x: window.innerWidth - 206, y: window.innerHeight - 240, w: 190, h: 136 }
      : { x: window.innerWidth - 364, y: window.innerHeight - 316, w: 340, h: 220 }),
    // And with a phone's keyboard up, as there: above the message field, or a one-line bar over the chat's header.
    { enabled: mini, minWidth: touch ? 264 : 190, minHeight: touch ? 168 : 128, keyboard: touch },
  );
  const compact = mini && miniWindow.compact;
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
  // As in the 1:1 call: the device notice goes with the focus maybe on it, which goes to the Devices button it is about.
  useFocusKept(box, () => box.current?.querySelector<HTMLElement>("[data-testid=call-devices]") ?? null);

  const { local, participants, activeSpeaker } = call;
  // Who comes and goes is said by the group's own name for them too, not the node's.
  const news = useCallNews(groupNameOf ? participants.map((p) => ({ ...p, name: groupNameOf(p.identity) })) : participants, connected, t);
  const everyone = [local, ...participants];
  // Everyone else by the group's own name for their key (WISP 602 § The reply): the node's name is not theirs to vouch for.
  const shown = (p: GroupCallParticipant) => (p === local || !groupNameOf ? p.name : groupNameOf(p.identity));
  const nameOf = (p: GroupCallParticipant) => (p === local ? t("calls.you") : shown(p));
  const order = useShareOrder(everyone.filter((p) => p.screen && p.tracks.screen).map((p) => p.identity));
  // The screen picked from the side stays large while others start and stop; once it stops, the latest is again.
  const [picked, setPicked] = useState<string | null>(null);
  if (picked && !order.includes(picked)) setPicked(null);
  const large = picked && order.includes(picked) ? picked : order[order.length - 1];
  const presenter = everyone.find((p) => p.identity === large) ?? null;
  // The other screens are tiles beside the faces, each a button that shows it large.
  const otherScreens = order.filter((id) => id !== large).map((id) => everyone.find((p) => p.identity === id)!);
  // The picked tile goes from the side: the focus goes to the one that took its place there, to switch back.
  const swapped = useRef<string | null>(null);
  useEffect(() => {
    const id = swapped.current;
    swapped.current = null;
    if (!id) return;
    [...(box.current?.querySelectorAll<HTMLElement>("[data-testid=group-call-show-screen]") ?? [])].find((b) => b.dataset.identity === id)?.focus({ preventScroll: true });
  }, [large, box]);
  const show = (id: string) => {
    swapped.current = large ?? null;
    setPicked(id);
  };
  // Each other face's volume (one level for their voice and their screen's sound) and the admin's menu, in the whole window: the small one has no room for them.
  const menuOf = (p: GroupCallParticipant) => mini || p === local ? undefined : (
    <>
      <TileVolume name={shown(p)} volume={volumeOf(p.identity)} max={volumeMaxOn(devices?.speaker)} onChange={(volume) => setVolume(p.identity, volume)} host={box} />
      {moderation && <TileModerationMenu identity={p.identity} name={shown(p)} moderation={moderation} host={box} />}
    </>
  );
  const faces = everyone.map((p) => (
    <Tile key={p.identity} person={p} you={p === local} kind="face" speaking={p.identity === activeSpeaker} name={nameOf(p)} face={shown(p)} menu={menuOf(p)} />
  ));
  const screenTiles = otherScreens.map((p) => {
    const label = p === local ? t("calls.group.showYourScreen") : t("calls.group.showScreen", { name: isolate(nameOf(p)) });
    const button = (
      <button type="button" onClick={() => show(p.identity)} data-testid="group-call-show-screen" data-identity={p.identity} aria-label={label} title={label}
        className="absolute inset-0 z-10 cursor-pointer rounded-xl hover:bg-white/10 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-accent" />
    );
    return <Tile key={`${p.identity}-screen`} person={p} you={p === local} kind="screen" speaking={false} name={fillNames(t("calls.group.screenOf"), { name: nameOf(p) })} face={shown(p)} menu={button} />;
  });
  // The small window shows one tile: the screen being shared, or else whoever speaks.
  const focus = presenter ?? everyone.find((p) => p.identity === activeSpeaker) ?? participants[0] ?? local;
  const columns = gridColumns(faces.length + screenTiles.length);

  const roundButton = "w-14 h-14 max-md:w-16 max-md:h-16 rounded-full flex items-center justify-center transition-colors cursor-pointer";
  // A shared screen lies under the buttons (it fills the window, or the small one): there a button at rest is white on
  // a black chip, as the name row's, and one turned off is white on the danger fill. White on a 10% white tint was
  // 1.0:1 over a white screen, and the danger red on its own tint 2.0:1. A red icon on the black chip reads under 2:1
  // there, so an off one takes Leave's solid fill, with a white ring inside to stay apart from it: in the small window
  // the two are the same size.
  const overPicture = !!presenter;
  const atRest = overPicture ? "bg-black/70 text-white hover:bg-black/80" : "bg-white/10 text-white hover:bg-white/20";
  const turnedOff = overPicture ? "bg-danger-fill text-white ring-2 ring-inset ring-white" : "bg-danger/30 text-danger";
  // What the admin took from you stays off, its button says so, and the ⓘ beside the controls says until when.
  const held = local.byAdmin;
  const anyHeld = !!held && (held.mic || held.camera || held.screen);
  const heldLook = "aria-disabled:opacity-50 aria-disabled:cursor-not-allowed";
  const screenLabel = held?.screen ? t("calls.group.offByAdmin") : local.screen ? t("calls.stopSharing") : t("calls.shareScreen");
  return createPortal(
    <div
      {...miniWindow.boxProps}
      data-testid="group-call"
      data-mini={mini}
      data-compact={compact || undefined}
      data-count={everyone.length}
      {...(mini ? {} : { role: "dialog", "aria-modal": true, "aria-label": groupName, tabIndex: -1 })}
      className={
        mini
          ? "call-mini floating fixed z-50 bg-chat-bg flex flex-col items-center justify-center rounded-xl border border-border shadow-2xl overflow-hidden"
          : `fixed inset-0 ${presenter ? "" : "max-md:top-6 max-md:rounded-t-2xl max-md:border-t max-md:border-border"} z-50 bg-chat-bg/95 max-md:bg-chat-bg flex flex-col focus:outline-none`
      }
    >
      {mini && !compact && CORNERS.map((corner) => <div key={corner} className={`float-grip float-grip-${corner}`} {...miniWindow.handleProps(corner)} />)}
      {compact && <p dir="auto" className="call-compact-name min-w-0 truncate text-text-primary text-sm font-medium">{groupName}</p>}
      <button
        onClick={() => (pinned ? onReturnToChat?.() : setMini(!mini))}
        className={`call-resize absolute top-4 left-4 z-20 w-11 h-11 rounded-full ${atRest} flex items-center justify-center cursor-pointer transition-colors`}
        title={pinned ? t("calls.window.chat") : mini ? t("calls.window.full") : t("calls.window.small")}
        data-testid="group-call-minimize"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          {mini ? <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" /> : <path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" />}
        </svg>
      </button>

      <div role="status" className="sr-only" data-testid="group-call-news">{news.map((line) => <p key={line}>{line}</p>)}</div>

      {participants.map((p) => p.tracks.audio && <TrackAudio key={p.identity} track={p.tracks.audio} speaker={devices?.speaker} volume={volumeOf(p.identity)} />)}
      {participants.map((p) => p.tracks.screenAudio && <TrackAudio key={`${p.identity}-screen`} track={p.tracks.screenAudio} speaker={devices?.speaker} volume={volumeOf(p.identity)} testId="group-call-screen-audio" />)}

      {mini ? (
        <div className="call-mini-tile absolute inset-0 grid">
          {focus === presenter ? (
            <Tile person={focus} you={focus === local} kind="screen" speaking={false} name={fillNames(t("calls.group.screenOf"), { name: nameOf(focus) })} face={shown(focus)} />
          ) : (
            <Tile person={focus} you={focus === local} kind="face" speaking={focus.identity === activeSpeaker} name={nameOf(focus)} face={shown(focus)} />
          )}
        </div>
      ) : (
        <>
          {/* On a phone the row keeps 12 px (the ⓘ's grown side) from the Small window button and from the "N removed" chip.
              Over a shared screen the window starts at the phone's top, so the row starts below its status bar. */}
          <div data-testid="group-call-top" className={`call-top flex items-center justify-center gap-1.5 max-md:gap-3 px-16 max-md:px-[72px] ${presenter ? "pt-[calc(1.5rem+env(safe-area-inset-top))]" : "pt-6"} pb-2`}>
            {/* Over a shared screen the name is on a black chip too, as the ⓘ and "Removed": white alone vanished on a white screen. */}
            <p dir="auto" data-over-picture={presenter ? true : undefined} data-testid="group-call-name" className={`min-w-0 truncate font-medium ${presenter ? "rounded-full bg-black/70 px-3 py-1 text-white" : "text-text-primary"}`}>{groupName}</p>
            {/* Its phone hit area reaches up into the window's top, not down onto the tiles drawn over it 8 px below. */}
            <InfoButton open={info} onToggle={() => setInfo(!info)} controls={infoId} testId="group-call-info" className={`max-md:before:-top-4 max-md:before:-bottom-2 ${presenter ? "bg-black/70 text-white hover:bg-black/80 hover:text-white aria-expanded:text-white" : ""}`} />
            {moderation && <RemovedFromCall moderation={moderation} nameOf={(identity) => (groupNameOf ? groupNameOf(identity) : identity)} host={box} overPicture={!!presenter} />}
          </div>
          {/* Over a shared screen in the theme's grey it was 2.3:1 on black in the light theme: there it is a dark chip, as the error notice is. */}
          {info && <p id={infoId} data-testid="group-call-info-text" className={`mx-auto text-center text-xs break-words ${presenter ? "mb-2 w-max max-w-[min(28rem,calc(100%-2rem))] rounded-lg bg-black/70 px-3 py-2 text-white" : "max-w-md px-4 pb-2 text-text-secondary"}`}>{t("calls.group.info")}</p>}
          {/* A shared screen fills the whole window, fitted whole, and the rest is drawn over it as in the 1:1 call: the
              name above, the faces at the side (along the bottom on a phone), the controls below. Laid out between them
              it had 60% of a 1280 × 800 window, and 22% of a phone's. Under the name row, which stays in the flow. */}
          {presenter ? (
            <>
              <div data-testid="group-call-stage" className="absolute inset-0 -z-10 grid">
                <Tile person={presenter} you={presenter === local} kind="screen" speaking={false} name={fillNames(t("calls.group.screenOf"), { name: nameOf(presenter) })} face={shown(presenter)} whole />
              </div>
              <div data-testid="group-call-faces" className="call-tiles absolute inset-0 pt-[calc(3.5rem+env(safe-area-inset-top))] z-10 pointer-events-none flex md:justify-end max-md:items-end">
                <div data-testid="group-call-side" className="pointer-events-auto md:w-48 max-md:h-28 max-md:w-full shrink-0 flex md:flex-col gap-2 overflow-auto">
                  {[...screenTiles, ...faces].map((tile) => <div key={tile.key} className="shrink-0 grid md:h-28 max-md:w-36">{tile}</div>)}
                </div>
              </div>
            </>
          ) : (
            <div data-testid="group-call-grid" className="call-tiles flex-1 min-h-0 grid gap-2 auto-rows-fr" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
              {faces}
            </div>
          )}
        </>
      )}

      {shownError && errorShown && (
        <p key={said.id} role="alert" data-testid="group-call-error" data-action={shownError.action}
          className="call-share-error call-group-error absolute bottom-32 max-md:bottom-[calc(8.5rem+env(safe-area-inset-bottom))] left-1/2 -translate-x-1/2 z-10 w-max max-w-[calc(100%-2rem)] rounded-lg bg-black/70 px-3 py-2 text-center text-xs text-white">
          <span dir={ownDirection(errorShown.title)} className="block font-medium">{errorShown.title}</span>
          {/* The small window has no room for it (index.css): there it is only said. */}
          {errorShown.next && (mini ? <span className="sr-only"> {errorShown.next}</span> : <span className="block">{errorShown.next}</span>)}
          {errorShown.android && (
            <button type="button" data-testid="group-call-error-settings" onClick={() => void openAppSettings()}
              className="relative mt-1 cursor-pointer rounded underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent before:absolute before:-inset-y-3 before:-inset-x-2 before:content-['']">
              {t("settings.noticesOpenSettings")}
            </button>
          )}
        </p>
      )}

      {anyHeld && heldInfo && !mini && (
        <p id={heldInfoId} data-testid="group-call-by-admin-text"
          className="absolute bottom-48 max-md:bottom-[calc(12rem+env(safe-area-inset-bottom))] left-1/2 -translate-x-1/2 z-10 w-max max-w-[min(24rem,calc(100%-2rem))] rounded-lg bg-black/70 px-3 py-2 text-center text-xs text-white">
          {t("calls.group.byAdminInfo")}
        </p>
      )}

      {!mini && <ModerationProblem moderation={moderation} />}

      {/* A headset unplugged, the chosen microphone back: said over the controls, in the whole window (the small one has no room). */}
      {!mini && devices?.notice && <DeviceNoticeBar devices={devices} />}

      <div className="call-controls absolute bottom-12 max-md:bottom-[calc(2rem+env(safe-area-inset-bottom))] left-0 right-0 flex items-center justify-center gap-6 max-md:gap-8 z-10">
        <button onClick={held?.mic ? undefined : onToggleMic} {...(held?.mic && { "aria-disabled": true })} data-testid="group-call-mic"
          title={held?.mic ? t("calls.group.mutedByAdmin") : local.mic ? t("calls.mute") : t("calls.unmute")}
          className={`call-compact-keep ${roundButton} ${heldLook} ${local.mic ? atRest : turnedOff}`}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            {local.mic
              ? <><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8" /></>
              : <><line x1="1" y1="1" x2="23" y2="23" /><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6M17 16.95A7 7 0 0 1 5 12v-2m14 0v2c0 .76-.13 1.49-.35 2.17M12 19v4M8 23h8" /></>}
          </svg>
        </button>
        <button onClick={held?.camera ? undefined : onToggleCamera} {...(held?.camera && { "aria-disabled": true })} data-testid="group-call-camera"
          title={held?.camera ? t("calls.group.offByAdmin") : local.camera ? t("calls.turnCameraOff") : t("calls.turnCameraOn")}
          className={`${roundButton} ${heldLook} ${local.camera ? atRest : turnedOff}`}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            {local.camera
              ? <><path d="M23 7l-7 5 7 5V7z" /><rect x="1" y="5" width="15" height="14" rx="2" ry="2" /></>
              : <><line x1="1" y1="1" x2="23" y2="23" /><path d="M21 21H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3m3-3h6l2 3h4a2 2 0 0 1 2 2v9.34m-7.72-2.06a4 4 0 1 1-5.56-5.56" /></>}
          </svg>
        </button>
        {devices && <DeviceMenu devices={devices} overVideo={false} overPicture={overPicture} host={mini ? null : box} />}
        {canShareScreen && (
          <button onClick={held?.screen ? undefined : onToggleScreen} {...(held?.screen && { "aria-disabled": true })} data-testid="group-call-screen"
            aria-label={screenLabel} title={screenLabel}
            className={`${roundButton} ${heldLook} ${local.screen ? "bg-accent text-on-accent forced-colors:forced-color-adjust-none forced-colors:bg-[color:Highlight] forced-colors:text-[color:HighlightText]" : atRest}`}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="2" y="4" width="20" height="13" rx="2" />
              <path d="M8 21h8M12 17v4M12 13V8m0 0l-2.5 2.5M12 8l2.5 2.5" />
            </svg>
          </button>
        )}
        {anyHeld && !mini && <InfoButton open={heldInfo} onToggle={() => setHeldInfo(!heldInfo)} controls={heldInfoId} testId="group-call-by-admin-info"
          className={overPicture ? "bg-black/70 text-white hover:bg-black/80 hover:text-white aria-expanded:text-white" : "text-white/80"} />}
        <button onClick={onLeave} data-testid="group-call-leave" title={t("calls.group.leave")}
          className="call-compact-keep w-16 h-16 max-md:w-[72px] max-md:h-[72px] rounded-full bg-danger-fill flex items-center justify-center text-white hover:bg-danger-fill/80 transition-colors cursor-pointer">
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
