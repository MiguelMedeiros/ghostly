import { useCallback, useEffect, useMemo, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { Sidebar } from "./components/Sidebar";
import { MobileTabBar } from "./components/MobileTabBar";
import { Chat } from "./pages/Chat";
import { chatRouteSession } from "./lib/url";
import { useIsMobile } from "./hooks/useIsMobile";
import { useViewportHeight } from "./hooks/useViewportHeight";

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
function useLoadedChats() {
  const routeSession = chatRouteSession(useLocation().pathname);
  const [callSession, setCallSession] = useState<string | null>(null);
  // The call window hangs here instead of inside its chat, which may be off
  // screen. Still within `LockGate`, so the lock reaches it like the rest.
  const [callLayer, setCallLayer] = useState<HTMLElement | null>(null);

  const onCallChange = useCallback(
    (sessionId: string, onCall: boolean) =>
      setCallSession((current) => (onCall ? sessionId : current === sessionId ? null : current)),
    [],
  );

  // Keyed by session id, so a chat that changes places here keeps its call.
  const loaded = useMemo(
    () => [...new Set([routeSession, callSession].filter((id): id is string => !!id))],
    [routeSession, callSession],
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
  const isMobile = useIsMobile();
  const { pathname } = useLocation();
  useViewportHeight();
  useThemeColor();
  const chats = useLoadedChats();

  const inChat = pathname.startsWith("/chat");

  if (!isMobile) {
    return (
      <div className="h-screen w-screen flex bg-app-bg">
        <Sidebar />
        {chats("flex-1 flex flex-col min-w-0")}
        {!inChat && (
          <div className="flex-1 flex flex-col min-w-0">
            <Outlet />
          </div>
        )}
      </div>
    );
  }

  // One screen at a time. The sidebar is the chat list and stays mounted: it is
  // what keeps the sessions polling and the notifications coming.
  const onChatList = pathname === "/";
  return (
    <div className="app-shell w-screen flex flex-col bg-app-bg">
      <div className={onChatList ? "flex-1 flex min-h-0" : "hidden"}>
        <Sidebar />
      </div>
      {chats("flex-1 flex flex-col min-h-0 min-w-0")}
      {!onChatList && !inChat && (
        <div className="flex-1 flex flex-col min-h-0 min-w-0">
          <Outlet />
        </div>
      )}
      {!inChat && <MobileTabBar />}
    </div>
  );
}
