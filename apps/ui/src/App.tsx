import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { Sidebar } from "./components/Sidebar";
import { MobileTabBar } from "./components/MobileTabBar";
import { InstallSteps } from "./components/InstallApp";
import { Chat } from "./pages/Chat";
import { chatRouteSession } from "./lib/url";
import { listSessions } from "./lib/storage";
import { parseCallSignal } from "@ghostly/core";
import { engine } from "@ghostly/browser/platform/engine";
import { useIsMobile } from "./hooks/useIsMobile";
import { useServicesPlatform } from "./hooks/useServicesPlatform";
import { useSettings } from "./contexts/SettingsContext";
import { newSpace } from "@ghostly/browser/backup/storage";
import { useViewportHeight } from "./hooks/useViewportHeight";
import { useEngineNick } from "./hooks/useAvatars";
import { useProfilePeek } from "./hooks/useProfilePeek";
import { guardFileDrops } from "./lib/pastedFiles";
import { useWakeLock } from "./hooks/useWakeLock";
import { useAppBadge } from "./lib/appBadge";
import { useWakeTableSync } from "./lib/wakePush";
import { useI18n } from "./contexts/I18nContext";

/** The browser's status bar follows the header of whichever theme is active. */
function useThemeColor() {
  useEffect(() => {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) return;
    const sync = () => {
      const color = getComputedStyle(document.documentElement).getPropertyValue("--theme-panel-header").trim();
      if (color) meta.setAttribute("content", color);
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, { attributes: true });
    return () => observer.disconnect();
  }, []);
}

/**
 * Which chats stay loaded: the one the address points at, and the one on a
 * call. Chats live here rather than in the router because leaving the address
 * of a chat must not unload it mid-call — a WebRTC connection dies with the
 * page that holds it, and so does the polling that would carry the hang-up.
 * The one on a call follows you to Settings as a small window instead.
 */
/**
 * Coming back to the window or tab after a while: a laptop that slept, an app left in the background.
 * Chats look for their contacts now, and a connection that dropped meanwhile is dialled again at once.
 */
function useWakeOnReturn() {
  useEffect(() => {
    let last = 0;
    const wake = () => {
      if (document.visibilityState !== "visible" || Date.now() - last < 5_000) return;
      last = Date.now();
      void engine.call("wake").catch(() => {});
    };
    // Back online (another network, a VPN up or down): discovery forgets the relays that failed on the old one.
    const online = () => { last = Date.now(); void engine.call("wake", { network: true }).catch(() => {}); };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);
    window.addEventListener("online", online);
    return () => { document.removeEventListener("visibilitychange", wake); window.removeEventListener("focus", wake); window.removeEventListener("online", online); };
  }, []);
}

/**
 * The peer holds items for away contacts in this profile's S3 storage (WISP 4xx), the one set up under
 * Profile → Backups: whenever that changes, the peer is told, credentials and space alike, and told when
 * it goes. The space is chosen here once, as a backup would choose it.
 */
function useHoldStorageSync() {
  const { settings, updateBackupStorage } = useSettings();
  const platform = useServicesPlatform();
  const s3 = settings.backupS3 ? JSON.stringify(settings.backupS3) : null;
  const space = settings.backupSpace;
  useEffect(() => {
    if (!platform) return;
    if (s3 && !space) { updateBackupStorage({ backupSpace: newSpace() }); return; }
    void platform.setHoldStorage(s3 && space ? { s3: JSON.parse(s3), space } : null).catch(() => {});
  }, [platform, s3, space, updateBackupStorage]);
}

/**
 * The peer tells contacts this profile's name (WISP 401 § name and picture), so it must know the name the
 * moment it is set on the Profile page, not only once some chat is opened. Each profile keeps its own.
 */
function useProfileNameSync() {
  const { settings } = useSettings();
  const engineNick = useEngineNick();
  const nick = settings.defaultNickname;
  useEffect(() => {
    if (engineNick !== undefined && engineNick !== nick) void engine.call("updateSettings", { settings: { nick } }).catch(() => {});
  }, [nick, engineNick]);
}

function useLoadedChats() {
  const routeSession = chatRouteSession(useLocation().pathname);
  const [callSession, setCallSession] = useState<string | null>(null);
  // A call keeps the screen on (Screen Wake Lock, where there is one).
  useWakeLock(!!callSession);
  // The call window hangs here instead of inside its chat, which may be off
  // screen. Still within `LockGate`, so the lock reaches it like the rest.
  const [callLayer, setCallLayer] = useState<HTMLElement | null>(null);

  // A call can come in for a chat that is not open: that chat is loaded, off screen, so it rings.
  const [ringSession, setRingSession] = useState<string | null>(null);
  useEffect(() => engine.onCallSignal((linkId, signal) => {
    if (parseCallSignal(signal)?.t !== "o") return;
    const peer = engine.state?.links.find((link) => link.id === linkId)?.peerPubKeyZ32;
    const session = peer ? listSessions().find((s) => s.peerPubKeyB64 === peer) : undefined;
    if (!session) return;
    setRingSession(session.id);
    // It holds itself once it rings (a call keeps its chat loaded); one that never does is let go.
    setTimeout(() => setRingSession((current) => (current === session.id ? null : current)), 15_000);
  }), []);

  const onCallChange = useCallback((sessionId: string, onCall: boolean) => {
    setCallSession((current) => (onCall ? sessionId : current === sessionId ? null : current));
    if (onCall) setRingSession((current) => (current === sessionId ? null : current));
  }, []);

  // Keyed by session id, so a chat that changes places here keeps its call.
  const loaded = useMemo(
    () => [...new Set([routeSession, callSession, ringSession].filter((id): id is string => !!id))],
    [routeSession, callSession, ringSession],
  );

  const render = (visibleClassName: string) => (
    <>
      {loaded.map((id) => (
        <div key={id} className={id === routeSession ? visibleClassName : "hidden"}>
          <Chat
            sessionId={id}
            visible={id === routeSession}
            onCallChange={onCallChange}
            callLayer={callLayer}
          />
        </div>
      ))}
      <div ref={setCallLayer} style={{ display: "contents" }} />
    </>
  );

  return render;
}

export function App() {
  useHoldStorageSync();
  useProfileNameSync();
  const isMobile = useIsMobile();
  const { pathname } = useLocation();
  useViewportHeight();
  useThemeColor();
  // A file dropped outside a chat never opens in place of the app; a chat takes its own drops.
  useEffect(() => guardFileDrops(), []);
  useWakeOnReturn();
  useAppBadge();
  useProfilePeek();
  const { t } = useI18n();
  // What a wake-up shows, and which chats it may name (the installed web app; nothing elsewhere).
  useWakeTableSync({ title: "Ghostly", body: t("pwa.wakeNotice"), call: t("pwa.wakeCall") });
  const chats = useLoadedChats();
  const mainRef = useRef<HTMLElement>(null);

  const inChat = pathname.startsWith("/chat");
  // A group is a conversation too: on a phone it takes the whole screen, without the tab bar.
  const inGroup = pathname.startsWith("/group/");

  // One tree for both layouts, each part in the same place: a phone turned on its side (or a window made narrow) moves
  // across the breakpoint, and a part React finds elsewhere is mounted anew. The open chat with it: its call, the video
  // or voice message playing, a recording.
  // On a phone, one screen at a time. The sidebar is the chat list and stays mounted: it is what keeps the sessions
  // polling and the notifications coming.
  const onChatList = pathname === "/";
  return (
    <div className={isMobile ? "app-shell w-full flex flex-col bg-app-bg" : "two-pane w-full flex bg-app-bg"}>
      {/* The first stop of the keys: past the chat list to the open page, however long the list is. A button, not
          a #fragment link: the router lives in the hash. */}
      {!isMobile && (
        <button type="button" data-testid="skip-to-content" onClick={() => mainRef.current?.focus()}
          className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:start-2 focus:z-[60] focus:rounded-lg focus:bg-accent focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-on-accent focus:outline-2 focus:outline-offset-2 focus:outline-accent">
          {t("sidebar.skipToContent")}
        </button>
      )}
      {!isMobile && <Sidebar />}
      <main ref={mainRef} tabIndex={isMobile ? undefined : -1}
        className={isMobile ? "flex-1 flex flex-col min-h-0 min-w-0" : "flex-1 flex min-w-0 focus:outline-none"}>
        {isMobile && (
          <div className={onChatList ? "flex-1 flex min-h-0" : "hidden"}>
            <Sidebar />
          </div>
        )}
        {chats(isMobile ? "flex-1 flex flex-col min-h-0 min-w-0" : "flex-1 flex flex-col min-w-0")}
        {(isMobile ? !onChatList && !inChat : !inChat) && (
          <div className={isMobile ? "flex-1 flex flex-col min-h-0 min-w-0" : "flex-1 flex flex-col min-w-0"}>
            <Outlet />
          </div>
        )}
      </main>
      {isMobile && !inChat && !inGroup && <MobileTabBar />}
      <InstallSteps />
    </div>
  );
}
