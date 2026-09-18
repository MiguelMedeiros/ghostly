import { useEffect } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { Sidebar } from "./components/Sidebar";
import { MobileTabBar } from "./components/MobileTabBar";
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

export function App() {
  const isMobile = useIsMobile();
  const { pathname } = useLocation();
  useViewportHeight();
  useThemeColor();

  if (!isMobile) {
    return (
      <div className="h-screen w-screen flex bg-app-bg">
        <Sidebar />
        <div className="flex-1 flex flex-col min-w-0">
          <Outlet />
        </div>
      </div>
    );
  }

  // One screen at a time. The sidebar is the chat list and stays mounted: it is
  // what keeps the sessions polling and the notifications coming.
  const onChatList = pathname === "/";
  const inChat = pathname.startsWith("/chat");
  return (
    <div className="app-shell w-screen flex flex-col bg-app-bg">
      <div className={onChatList ? "flex-1 flex min-h-0" : "hidden"}>
        <Sidebar />
      </div>
      {!onChatList && (
        <div className="flex-1 flex flex-col min-h-0 min-w-0">
          <Outlet />
        </div>
      )}
      {!inChat && <MobileTabBar />}
    </div>
  );
}
